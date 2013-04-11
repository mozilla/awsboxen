#!/usr/bin/env node

const docopt = require('docopt');

const config = require('./config');
const projinfo = require('./projinfo');
const cfn = require('./cfn');

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
'  awsboxen showconfig [--profile=PROFILE] [<ref>]\n'+
'\n'+
'Arguments:\n'+
'  <name>:  a unique name used to name identify this deployment\n'+
'  <ref>:   the git tag, commit, or other ref that should be deployed\n'+
'\n'+
'Options:\n'+
' -h --help                         show this help message and exit\n'+
' -p PROFILE --profile=PROFILE      name of the deployment profile to use\n'+
'\n';


// The individual sub-commands that can be run through the CLI.
//
module.exports.commands = {

  showconfig: function list(opts, cb) {
    projinfo('.', opts.profile, opts.ref).loadConfig(function(err, cfg) {
      if (err) return cb(err);
      console.log(JSON.stringify(cfg, null, 2));
      cb(null);
    });
  },
 
  deploy: function deploy(opts, cb) {
    projinfo('.', opts.profile, opts.ref).loadConfig(function(err, cfg) {
      if (err) return cb(err);

      // XXX TODO: generate AMIs for each box description.
      delete cfg.Boxen;

      // Send the rest of the template through to CloudFormation.
      cfn.deployStack(opts, cfg, function(err) {
        return cb(err);
      });
    });
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


module.exports.main = function main(argv, cb) {
  // Parse command-line arguments.
  // XXX TODO: stop it from exiting the program itself.
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
    console.log('Error processing options!');
    return cb(1);
  }

  if (commandOptions.ref) {
    console.log('Sorry, working with explicit refs is not yet supported :-(');
    return cb(1);
  }

  // Now we can run the command.
  module.exports.commands[command](commandOptions, function(err) {
    if (err) {
      console.error(err);
      return cb(1);
    }
    return cb(0);
  });
};


// Make this executable as a script, but also importable as a module.
//
if (require.main === module) {
  process.title = 'awsboxen';
  module.exports.main(process.argv.slice(2), function(code) {
    process.exit(code);
  });
}
