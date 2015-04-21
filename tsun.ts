/// <reference path='./typings/node.d.ts' />
/// <reference path='./typings/colors.d.ts' />
/// <reference path='./typings/typescript.d.ts' />

import readline = require('readline')
import util = require('util')
import vm = require('vm')
import path = require('path')
import ConsoleModule = require('console')
import ts = require('typescript')
import fs = require('fs')
import colors = require('colors')
import os = require('os')
import child_process = require('child_process')

var Console = ConsoleModule.Console
var builtinLibs = require('repl')._builtinLibs

colors.setTheme({
  warn: 'red'
})

var options = require('optimist')
  .usage('A simple ts REPL.\nUsage: $0')
  .alias('h', 'help')
  .describe('h', 'Print this help message')
  .alias('f', 'force')
  .describe('f', 'Force tsun to evaluate code with ts errors.')
  .alias('v', 'verbose')
  .describe('v', 'Print compiled javascript before evaluating.')
  .alias('o', 'out')
  .describe('o', 'output directory relative to temporary')
  .describe('autolib', 'import libs under ./typings directory')

var argv = options.argv

if (argv._.length === 1) {
  runCode()
}
if (argv.h) {
  options.showHelp()
  process.exit(1)
}

function runCode() {
  // run code in temp path, and cleanup
  var temp = require('temp')
  temp.track()
  process.on('SIGINT',  () => temp.cleanupSync())
  process.on('SIGTERM', () => temp.cleanupSync())

  let tempPath = temp.mkdirSync('tsrun')
  let outDir = tempPath
  if (argv.o) {
    outDir = path.join(tempPath, argv.o)
  }
  let compileError = compile(argv._, {
      outDir,
      noEmitOnError: true,
      target: ts.ScriptTarget.ES5,
      module: ts.ModuleKind.CommonJS,
  })
  if (compileError) process.exit(compileError)
  linkDir(process.cwd(), tempPath)
  // slice argv. 0: node, 1: tsun binary 2: arg
  var newArgv = process.argv.slice(2).map(arg => {
    if (!/\.ts$/.test(arg)) return arg
    return path.join(outDir, arg.replace(/ts$/, 'js'))
  })
  child_process.execFileSync('node', newArgv, {
    stdio: 'inherit'
  })
  process.exit()
}

function linkDir(src, dest) {
  let files = ['node_modules', 'typings']
  for (let file of files) {
    let srcpath = path.join(src, file)
    let destpath = path.join(dest, file)
    fs.symlinkSync(srcpath, destpath, 'dir')
  }
}

function compile(fileNames: string[], options: ts.CompilerOptions): number {
    var program = ts.createProgram(fileNames, options);
    var emitResult = program.emit();

    var allDiagnostics = ts.getPreEmitDiagnostics(program).concat(emitResult.diagnostics);

    allDiagnostics.forEach(diagnostic => {
      console.log(diagnostic)
      var message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
      if (!diagnostic.file) return console.log(message)
      var { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
      console.log(`${diagnostic.file.fileName} (${line + 1},${character + 1}): ${message}`);
    });

    var exitCode = emitResult.emitSkipped ? 1 : 0;
    return exitCode
}


var defaultPrompt = '> ', moreLinesPrompt = '..';
var defaultPrefix = '';
var context = createContext();
var verbose = argv.v;

function getInitialCommands() {
  var libPath = path.resolve(__dirname, '../typings/node.d.ts')
  var codes = [`/// <reference path="${libPath}" />`]
  if (argv.autolib) {
    try {
      let dirs = fs.readdirSync('typings')
      for (let dir of dirs) {
        codes.push(`/// <reference path="${dir}" />`)
      }
    } catch(e) {
    }
  }
  return codes.join('\n')
}

var versionCounter = 0
var dummyFile = '__dummy__' + Math.random() + '.ts'
var codes = getInitialCommands()
var buffer = ''

var serviceHost: ts.LanguageServiceHost = {
  getCompilationSettings: () => ({
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES5
  }),
  getScriptFileNames: () => [dummyFile],
  getScriptVersion: (fileName) => {
    return fileName === dummyFile && versionCounter.toString()
  },
  getScriptSnapshot: (fileName) => {
    try {
      var text = fileName === dummyFile
        ? codes
        : fs.readFileSync(fileName).toString()
      return ts.ScriptSnapshot.fromString(text)
    } catch(e) {

    }
  },
  getCurrentDirectory: () => process.cwd(),
  getDefaultLibFileName: (options) => path.join(__dirname, '../node_modules/typescript/bin/lib.core.es6.d.ts')
}

var service = ts.createLanguageService(serviceHost, ts.createDocumentRegistry())

var rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  completer(line) {
    // append new line to get completions, then revert new line
    versionCounter++
    let originalCodes = codes
    codes += buffer + '\n' + line
    let completions = service.getCompletionsAtPosition(dummyFile, codes.length)
    if (!completions) {
      codes = originalCodes
      return [[], line]
    }
    let prefix = /[A-Za-z_$]+$/.exec(line)
    let candidates = []
    if (prefix) {
      let prefixStr = prefix[0]
      candidates = completions.entries.filter((entry) => {
        let name = entry.name
        return name.substr(0, prefixStr.length) == prefixStr
      }).map(entry => entry.name)
    } else {
      candidates = completions.entries.map(entry => entry.name)
    }
    codes = originalCodes
    return [candidates, prefix ? prefix[0] : line]
  }
});

// Much of this function is from repl.REPLServer.createContext
function createContext() {
  'use strict';
  var context;
  context = vm.createContext();
  for (var g in global) {
    context[g] = global[g];
  }
  context.console = new Console(process.stdout);
  context.global = context;
  context.global.global = context;
  context.module = module;
  context.require = require;

  // Lazy load modules on use
  builtinLibs.forEach(function (name) {
    Object.defineProperty(context, name, {
      get: function () {
        var lib = require(name);
        context[name] = lib;
        return lib;
      },
      // Allow creation of globals of the same name
      set: function (val) {
        delete context[name];
        context[name] = val;
      },
      configurable: true
    });
  });

  return context;
}

function getType(name) {
  let names = service.getSourceFile(dummyFile).getNamedDeclarations().map(t => t.name)
  let nameText = names.map(t => t.getText())
  if (nameText.indexOf(name) >= 0) {
    let info = names[nameText.indexOf(name)]
    let quickInfo = service.getQuickInfoAtPosition(dummyFile, info.pos+1)
    console.log(ts.displayPartsToString(quickInfo.displayParts).blue)
  } else {
    console.log(`identifier ${name} not found`.yellow)
  }
}

function printHelp() {
  console.log(`
tsun repl commands
:type identifier   print the type of an identifier
:clear             clear all the code
:print             print code input so far
:help              print this manual
  `.blue)
}

function replLoop(prompt, prefix, code) {
  code = prefix + '\n' + code;
  var openCurly = (code.match(/\{/g) || []).length;
  var closeCurly = (code.match(/\}/g) || []).length;
  var openParen = (code.match(/\(/g) || []).length;
  var closeParen = (code.match(/\)/g) || []).length;
  if (openCurly === closeCurly && openParen === closeParen) {
	buffer = ''
    let fallback = codes
    codes += code
    versionCounter++
    let current = ts.transpile(code)
    let emit = service.getEmitOutput(dummyFile)
    let allDiagnostics = service.getCompilerOptionsDiagnostics()
      .concat(service.getSyntacticDiagnostics(dummyFile))
      .concat(service.getSemanticDiagnostics(dummyFile))

    allDiagnostics.forEach(diagnostic => {
      let message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
      console.warn(message.red.bold);
    })
    if (verbose) {
      console.debug(current);
    }
    if (allDiagnostics.length) {
      codes = fallback
      return repl(defaultPrompt, defaultPrefix);
    }
    try  {
      var result = vm.runInContext(current, context);
      console.log(util.inspect(result, false, 2, true));
    } catch (e) {
      console.log(e.stack);
    }
    repl(defaultPrompt, defaultPrefix)
  } else {
    var indentLevel = openCurly - closeCurly + openParen - closeParen;
    var nextPrompt = '';
    for (var i = 0; i < indentLevel; i++) {
      nextPrompt += moreLinesPrompt;
    }
	buffer = code
    repl(nextPrompt, code);
  }
}


function repl(prompt, prefix) {
  'use strict';
  rl.question(prompt, function (code) {
    if (/^:type/.test(code)) {
      let identifier = code.split(' ')[1]
      if (!identifier) {
        console.log(':type command need names!'.red)
        return repl(prompt, prefix)
      }
      getType(identifier)
      return repl(prompt, prefix)
    }
    if (/^:help/.test(code)) {
      printHelp()
      return repl(prompt, prefix)
    }
    if (/^:clear/.test(code)) {
      codes = getInitialCommands()
      return repl(prompt, prefix)
    }
    if (/^:print/.test(code)) {
      console.log(codes)
      return repl(prompt, prefix)
    }
    replLoop(prompt, prefix, code)
  });
}

console.log('TSUN'.blue, ': TypeScript Upgraded Node')
console.log('type in TypeScript expression to evaluate')
console.log('type', ':help'.blue.bold, 'for commands in repl')
console.log('')
repl(defaultPrompt, defaultPrefix);
