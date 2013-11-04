/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/*
 * Automatically run various linty checks over the project source files.
 * Current checks include:
 *
 *    - jshint, with customizable options
 *    - checking for MPL license headers
 *
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const async = require('async');

const jshint = require('jshint').JSHINT;


// Find .js files beneath the given path, excluding 'node_modules' directories.
//
// This is a convenience for listing all .js files in the project without
// having to enumerate them, and thus risking leaving some untested.
//
function findJSFiles(pathName) {
  var jsFiles = [];
  if (fs.statSync(pathName).isDirectory()) {
    fs.readdirSync(pathName).forEach(function(childName) {
      if(childName !== 'node_modules') {
        var childPathName = path.join(pathName, childName);
        jsFiles = jsFiles.concat(findJSFiles(childPathName));
      }
    });
  } else {
    if (pathName.substr(-3) === '.js') {
      jsFiles.push(pathName);
    }
  }
  return jsFiles;
}


// Find the .jshintrc file most closely placed to the given .js file.
// Does some simple caching because many .js files will likely share
// the same .jshintrc file.
//
function findJSHintRCFile(pathName) {
  var dir = path.dirname(pathName);
  // Have we already found the .jshintrc file for that directory?
  if (findJSHintRCFile.cache[dir]) {
    return findJSHintRCFile.cache[dir];
  }
  // Have we reached the root directory?
  var parent = path.resolve(dir, '..');
  if (dir === parent) {
    return null;
  }
  // See if one exists in this directory.
  var jsHintRCFile = path.join(dir, '.jshintrc');
  if (fs.existsSync(jsHintRCFile)) {
    findJSHintRCFile.cache[dir] = jsHintRCFile;
    return jsHintRCFile;
  }
  // Recurse if it wasn't found.
  jsHintRCFile = findJSHintRCFile(dir);
  if (jsHintRCFile) {
    findJSHintRCFile.cache[dir] = jsHintRCFile;
    return jsHintRCFile;
  }
  // Whelp, looks like there's nothing to be found.
  return null;
}
findJSHintRCFile.cache = {};


// Run jshint on a particular path, returning an array of errors for
// all .js files contained therein.
//
// This does its own searching for .js files, so we don't forget to add
// new ones to the tests.  It also does its own searching for .jshintrc
// files, because that functionality is part of the jshint cli and not
// its importable lib.
//
function jshintExaminePath(pathName) {
  var errors = [];
  findJSFiles(pathName).forEach(function(filePathName) {
    var jsHintRCFile = findJSHintRCFile(filePathName);
    var rc = jsHintRCFile ? JSON.parse(fs.readFileSync(jsHintRCFile)) : null;
    var src = fs.readFileSync(filePathName).toString();
    if (!jshint(src, rc)) {
      errors = errors.concat(jshint.errors.map(function(e) {
        return e.reason + ' ' + filePathName + ':' + e.line;
      }));
      jshint.errors.splice(0);
    }
  });
  return errors;
}


describe('linty source checks', function() {

  it('jshint should report no warnings for our source files', function(done) {
    var errors = jshintExaminePath(path.dirname(__dirname));
    if (errors.length) {
      errors.forEach(function(e) {
        console.log(e);
      });
      assert.ok(false);
    }
    done();
  });

  it('all source files should have the MPL license header', function(done) {
    var licenseText = 'subject to the terms of the Mozilla Public';
    var jsFiles = findJSFiles(path.dirname(__dirname));
    async.eachSeries(jsFiles, function(jsFilePath, cb) {
      var jsLines = fs.readFileSync(jsFilePath).toString().split('\n');
      if (jsLines[0].indexOf('#!') === 0) {
        jsLines.shift();
      }
      if (jsLines[0].indexOf(licenseText) === -1) {
        assert.fail('missing MPL license header: ' + jsFilePath);
      }
      cb();
    }, function(err) {
      assert.equal(err, null);
      done();
    });
  });

});
