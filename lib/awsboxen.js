#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/*
 * Command-line `awsboxen` client.
 *
 * This module implements the CLI for awsboxen, but it's also importable as
 * a standard module if you want to do something strange on top of it.  Most
 * functionality is implemented in other, more API-focussed modules to which
 * this is simply a wrapper.
 *
 */

const fs = require('fs');
const path = require('path');
const async = require('async');
const docopt = require('docopt');
const semver = require('semver');

const config = require('./config');
const loadTemplate = require('./loadTemplate');
const freezer = require('./freezer');
const cfn = require('./cfn');

// Our command-line options and usage string.
// This becomes a working parser by the magic of docopt.
//
// Ye Gods, there must be a better way to do multi-line strings in JS...
//
const USAGE = ''+
'awsboxen\n'+
'\n'+
'Usage:\n'+
'  awsboxen [options] deploy [-D PARAM...] <name>\n'+
'  awsboxen [options] freeze [-D PARAM...] [<box>...]\n'+
'  awsboxen [options] showconfig\n'+
'  awsboxen [options] list\n'+
'  awsboxen [options] info <name>\n'+
'  awsboxen [options] teardown <name>\n'+
'  awsboxen -h | --help\n'+
'  awsboxen --version\n'+
'\n'+
'Arguments:\n'+
'  <name>:  a unique name used to name identify this deployment\n'+
'  <box>:   name of a Boxen declaration to freeze; defaults to all boxen\n'+
'\n'+
'Options:\n'+
' -h --help                         show this help message and exit\n'+
' --version                         show version number and exit\n'+
' -p PROFILE, --profile=PROFILE     name of the deployment profile to use\n'+
' -D PARAM, --define=PARAM          key=value defn of template parameters\n'+
' --ignore-uncommitted              proceed despite uncommitted changes\n'+
' --aws-id                          aws access key id; defaults to $AWS_ID\n'+
' --aws-secret                      aws secret key; defaults to $AWS_SECRET\n'+
' --aws-region                      aws region; defaults to us-east-1\n'+
'\n';


// Try to parse the current version number out of the package.json file.
//
module.exports.version = null;
(function() {
  var packageJsonPath = path.resolve(__dirname, '..', 'package.json');
  try {
    var packageJson = fs.readFileSync(packageJsonPath);
    var packageData = JSON.parse(packageJson);
    module.exports.version = packageData.version;
  } catch (e) {}
})();



// The individual sub-commands that can be run through the CLI.
//
module.exports.commands = {

  showconfig: function showconfig(opts, cb) {
    opts.ignore_uncommitted = true;
    loadAndCheckConfig('.', opts, function(err, cfg) {
      if (err) return cb(err);
      // Generate stub parameters for each boxen AMI.
      async.eachSeries(Object.keys(cfg.Boxen), function(boxName, cb) {
        cfg.Parameters[boxName + 'AMI'] = {
          Type: 'String',
          Default: 'ami-XXXXXX'
        };
        cb(null);
      }, function(err) {
          if (err) return cb(err);
          console.log(JSON.stringify(cfg, null, 2));
          cb(null, cfg);
      });
    });
  },
 
  deploy: function deploy(opts, cb) {
    async.waterfall([
      // Load the selected configuration.
      function loadTheConfig(cb) {
        loadAndCheckConfig('.', opts, function(err, cfg) {
          if (!err && cfg.AWSBoxenVersion) {
              delete cfg.AWSBoxenVersion;
          }
          return cb(err, cfg);
        });
      },
      // Generate AMIs for each box description.
      // The AMI id becomes a cfn template paramter.
      function generateBoxenAMIs(cfg, cb) {
        async.eachSeries(Object.keys(cfg.Boxen), function(boxName, cb) {
          var boxCfg = cfg.Boxen[boxName];
          freezer.createAMI(opts, '.', boxName, boxCfg, function(e, id) {
            if (e) return cb(e);
            cfg.Parameters[boxName + 'AMI'] = {
              Type: 'String',
              Default: id
            };
            cb(null);
          });
        }, function(err) {
          delete cfg.Boxen;
          cb(err, cfg);
        });
      },
      // Deploy the completed CloudFormation template.
      function deployTheStack(cfg, cb) {
        cfn.deployStack(opts, cfg, function(err, stack) {
          if (err) return cb(err);
          console.log('Stack ' + stack.name + ' successfully deployed!');
          for (var k in stack) {
            if(stack.hasOwnProperty(k)) {
              console.log('  ' + k + ':  ' + stack[k]);
            }
          }
          cb(null, stack);
        });
      }
    ], cb);
  },

  list: function list(opts, cb) {
    cfn.listStacks(opts, function(err, stackNames) {
      if (err) return cb(err);
      stackNames.forEach(function(name) {
        console.log(name);
      });
      cb(null, stackNames);
    });
  },

  info: function list(opts, cb) {
    cfn.checkStack(opts, function(err, stack) {
      if (err) return cb(err);
      if (!stack) return cb('no such stack: "' + opts.name + '"');
      console.log('Info for ' + opts.name + ':');
      for (var k in stack) {
        if(stack.hasOwnProperty(k)) {
          console.log('  ' + k + ':  ' + stack[k]);
        }
      }
      cb(null, stack);
    });
  },

  teardown: function list(opts, cb) {
    cfn.teardownStack(opts, function(err) {
      return cb(err);
    });
  },


  freeze: function freeze(opts, cb) {
    loadAndCheckConfig('.', opts, function(err, cfg) {
      if (err) return cb(err);
      // Freeze the specified boxen, or all if none were specified.
      if (opts.box.length === 0) {
        opts.box = Object.keys(cfg.Boxen);
      } else {
        for (var i=0; i < opts.box.length; i++) {
          if (!cfg.Boxen[opts.box[i]]) {
            return cb('unknown Box: ' + opts.box[i]);
          }
        }
      }
      // Create all the AMIs, collecting their ids for later reporting.
      // This generates a lot of console output, so we don't want to
      // print the final ids in the middle of it where they'll get lost.
      var amiIds = {};
      async.eachSeries(opts.box, function(boxName, cb) {
        var boxCfg = cfg.Boxen[boxName];
        freezer.createAMI(opts, '.', boxName, boxCfg, function(err, id) {
          if (err) return cb(err);
          amiIds[boxName] = id;
          return cb(null);
        });
      }, function(err) {
        if (err) return cb(err);
        // Now we can print the list of AMI ids.
        console.log("Successfully generated AMIs for your frozen boxen:");
        async.eachSeries(opts.box, function(boxName, cb) {
          console.log('  ' + boxName + ': ' + amiIds[boxName]);
          cb(null);
        }, function(err) {
          cb(err, amiIds);
        });
      });
    });
  }

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
      var match = /(<([A-Za-z0-9\-]+)>)|(--([A-Za-z0-9\-]+))/.exec(k);
      if (!match) {
        if (options[k]) {
          command = k;
        }
      } else {
        var name = match[2] || match[4];
        name = name.replace("-", "_");
        if (name && name !== 'help') {
          commandOptions[name] = options[k];
        }
      }
    }
  }

  if(commandOptions.version) {
    console.log('awsboxen', module.exports.version || 'DEV');
    return cb(0);
  }

  // Fill in any unspecified parameters that have useful defaults.
  if (!commandOptions.aws_id) {
    commandOptions.aws_id = process.env.AWS_ID;
  }
  if (!commandOptions.aws_secret) {
    commandOptions.aws_secret = process.env.AWS_SECRET;
  }
  if (!commandOptions.aws_region) {
    commandOptions.aws_region = process.env.AWS_REGION;
    if (!commandOptions.aws_region) {
      commandOptions.aws_region = 'us-east-1';
    }
  }

  // Normalize parameter definitions into a hash.
  // opts.define may be an array or a plain string, and each string
  // might contain several comma-separated key=value pairs.
  if (commandOptions.define) {
    var define = {};
    if (typeof commandOptions.define !== 'object') {
      commandOptions.define = [commandOptions.define];
    }
    commandOptions.define.forEach(function(definition) {
      definition.split(',').forEach(function(definition) {
        var bits = definition.split('=');
        define[bits[0]] = bits.slice(1).join('=');
      });
    });
    commandOptions.define = define;
  }

  // That should have produced a usable command name.
  // Error out if not.
  if (!command) {
    console.log('Error processing options!');
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


// Helper function to load and sanity-check the awsboxen config file.
//
function loadAndCheckConfig(projDir, opts, cb) {
  loadTemplate(projDir, opts, function(err, cfg) {
    if (err) return cb(err);
    // If the template declares a min/max supported version, ensure
    // that we're compatible with that declaration.
    if (cfg.AWSBoxenVersion) {
      if (!semver.satisfies(module.exports.version, cfg.AWSBoxenVersion)) {
        var errmsg = 'awsboxen version (' + module.exports.version + ') ';
        errmsg += 'does not satisfy requirement (' + cfg.AWSBoxenVersion + ')';
        return cb(errmsg);
      }
    }
    return cb(null, cfg);
  });
}


// Make this executable as a script, but also importable as a module.
//
if (require.main === module) {
  process.title = 'awsboxen';
  module.exports.main(process.argv.slice(2), function(code) {
    process.exit(code);
  });
}
