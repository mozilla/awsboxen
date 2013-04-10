#!/usr/bin/env node

const docopt = require('docopt');

// Our command-line options.
// This becomes a working parser by the magic od docopt.
// Ye Gods, there must be a better way to do multi-line strings in JS...
//
const USAGE = ''+
'awsboxen\n'+
'\n'+
'Usage:\n'+
'  awsboxen deploy [--profile=PROFILE] <name> [<ref>]\n'+
'  awsboxen list [--profile=PROFILE]\n'+
'  awsboxen info <name>\n'+
'  awsboxen teardown <name>\n'+
'\n'+
'Arguments:\n'+
'  <name>:  a unique name used to name identify this deployment\n'+
'  <ref>:  the git tag, commit, or other ref that should be deployed\n'+
'\n'+
'Options:\n'+
' -h --help                         show this help message and exit\n'+
' -p PROFILE --profile=PROFILE      name of the deployment profile to use\n'+
'\n';


// The individual sub-commands that can be run through the CLI.
//
module.exports.commands = {

  deploy: function deploy(opts, cb) {
    console.log("depoying", opts);
    cb(null);
  },

  list: function list(opts, cb) {
    console.log("listing", opts);
    cb(null);
  },

  info: function list(opts, cb) {
    console.log("getting info", opts);
    cb(null);
  },

  teardown: function list(opts, cb) {
    console.log("tearing down", opts);
    cb(null);
  },

};

module.exports.main = function main(argv) {
  var options = docopt.docopt(USAGE, {argv: argv});

  // Gather command-line options and arguments into a dict,
  // without all the docopt formatting cruft.
  var command = null;
  var commandOptions = {};
  for (var k in options) {
    if (options.hasOwnProperty(k)) {
      var match = /(<([A-Za-z0-0]+)>)|(--([A-Za-z0-9]+))/.exec(k);
      if (!match) {
        if (options[k]) {
          command = k;
        }
      } else {
        var name = match[2] || match[4];
        if (name && name !== 'help') {
          commandOptions[name] = options[k];
        }
      }
    }
  }

  // That should have produced a usable command name.
  // Error out if not.
  if (!command) {
    console.log("Error processing options!");
    return 1;
  }
  return module.exports.commands[command](commandOptions);
};

// Make this executable as a script, but also importable as a module.
//
if (require.main === module) {
  process.title = 'awsboxen';
  process.exit(module.exports.main(process.argv.slice(2)));
}
