//
// A high-level wrapper over the CloudFormation web api.
//
// The functions implemented in this module correspond roughly to the
// high-level actions that can be taken through the command-line interface,
// e.g. "deploy a stack" or "list all stack names".
//

const async = require('async');
const aws = require('awssum-amazon');
const CloudFormation = require('awssum-amazon-cloudformation').CloudFormation;


const SUCCESS_STATUSES = ['CREATE_COMPLETE', 'DELETE_COMPLETE',
                          'UPDATE_COMPLETE'];
const FAILURE_STATUSES = ['CREATE_FAILED', 'ROLLBACK_FAILED',
                          'ROLLBACK_COMPLETE', 'DELETE_FAILED',
                          'UPDATE_ROLLBACK_FAILED',
                          'UPDATE_ROLLBACK_COMPLETE'];
const INFLIGHT_STATUSES = ['CREATE_IN_PROGRESS', 'ROLLBACK_IN_PROGRESS',
                           'DELETE_IN_PROGRESS', 'UPDATE_IN_PROGRESS',
                           'UPDATE_COMPLETE_CLEANUP_IN_PROGRESS',
                           'UPDATE_ROLLBACK_IN_PROGRESS',
                           'UPDATE_ROLLBACK_COMPLETE_CLEANUP_IN_PROGRESS'];


module.exports = {
  checkStack: checkStack,
  deployStack: deployStack,
  listStacks: listStacks,
  teardownStack: teardownStack
};


//  Get a connection to the CloudFormation API.
//  Use paramters from the given options, or defaults from environment.
//
function getConnection(opts, cb) {
  var cfn = null;
  var err = null;
  try {
    cfn = new CloudFormation({
      accessKeyId: opts.aws_id || process.env.AWS_ID,
      secretAccessKey: opts.aws_secret || process.env.AWS_SECRET,
      region: opts.aws_region || aws.US_EAST_1
    });
  } catch (e) { err = e; }
  cb(err, cfn);
}


//  Check the status of a deployed stack.
//  The given options must include a 'name' key naming the stack.
//  The result is either null if there is no such stack, or an object
//  with whichever of the following keys are currently known:
//
//    status:  the status string for the stack
//    XXX TODO: implement at least 'commitId' and 'profile'.
//    Not sure how we'll encode this information though...
//
function checkStack(opts, cb) {
  getConnection(opts, function(err, cfn) {
    if (err) return cb(err);
    cfn.DescribeStacks({ StackName: opts.name }, function(err, res) {
      // An error response might indicate that the stack doesn't exist,
      // or that something more serious has gone wrong.
      if (err) {
       if (err.Body && err.Body.ErrorResponse) {
         var msg = err.Body.ErrorResponse.Error.Message;
         if (msg === 'Stack:' + opts.name + ' does not exist') {
           return cb(null, null);
         }
       }
       return cb(extractError(err)); 
      }
      // Now we can safely grab info out of the stack description.
      res = res.Body.DescribeStacksResponse.DescribeStacksResult.Stacks.member;
      cb(null, {
        id: res.StackId,
        name: res.StackName,
        status: res.StackStatus
      });
    });
  });
}


//  Wait for a stack to settle into a steady state.
//  Returns the final result of checkStack() once steady state is reached.
//
function waitForStack(opts, cb) {
  var stack = null;
  async.doWhilst(function(cb) {
    setTimeout(function() {
      checkStack(opts, function(err, res) {
        console.log(opts.name + ': ' + res ? res.status : null);
        stack = res;
        cb(err);
      });
    }, 1000);
  }, function() {
    return stack && INFLIGHT_STATUSES.indexOf(stack.status) !== -1;
  }, function(err) {
    return cb(err, stack);
  });
}


//  Deploy a CloudFormation stack.
//  The given options must include a 'name' key naming the stack.
//  This will create the stack if it doesn't exist, and update it otherwise.
//
function deployStack(opts, cfg, cb) {
  getConnection(opts, function(err, cfn) {
    if (err) return cb(err);
    checkStack(opts, function(err, stack) {
      if (err) return cb(err);
      // Should we create a new stack, or update an existing one?
      var action, successStatus;
      if (!stack) {
        action = function() { cfn.CreateStack.apply(cfn, arguments); };
        successStatus = 'CREATE_COMPLETE';
      } else {
        action = function() { cfn.UpdateStack.apply(cfn, arguments); };
        successStatus = 'UPDATE_COMPLETE';
      }
      action({
          StackName: opts.name,
          TemplateBody: JSON.stringify(cfg)
      }, function(err) {
        // An error is reported id the config hasn't changed since last deploy.
        // We don't want to propagate that one to the client.
        if (err) {
          if (err.Body && err.Body.ErrorResponse) {
            var msg = err.Body.ErrorResponse.Error.Message;
            if (msg === 'No updates are to be performed.') {
              return cb(null, stack);
            }
          }
          return cb(extractError(err)); 
        }
        waitForStack(opts, function(err, stack) {
          if (err) return cb(err);
          if (!stack) return cb('CREATE_FAILED');
          if (stack.status !== successStatus) return cb(stack.status);
          cb(null, stack);
        });
      });
    });
  });
}


// Extract a useful error object.
// This peeks inside the awssum error response to return the actual body,
// but passes other error object through unchanged.
//
function extractError(err) {
  if (!err) return err;
  if (!err.Body) return err;
  return err.Body;
}


// List all the currently available stacks.
//
function listStacks(opts, cb) {
  // XXX TODO: implement handling of NextToken pagination thing.
  getConnection(opts, function(err, cfn) {
    if (err) return cb(err);
    cfn.ListStacks({}, function(err, res) {
      if (err) return cb(extractError(err)); 
      res = res.Body.ListStacksResponse.ListStacksResult.StackSummaries.member;
      var stackNames = [];
      res.forEach(function(stack) {
        if (stack.StackStatus !== 'DELETE_COMPLETE') {
          stackNames.push(stack.StackName);
        }
      });
      cb(null, stackNames);
    });
  });
}


//  Completely tear down a stack.
//
function teardownStack(opts, cb) {
  getConnection(opts, function(err, cfn) {
    if (err) return cb(err);
    cfn.DeleteStack({ StackName: opts.name }, function(err) {
      if (err) return cb(extractError(err)); 
      waitForStack(opts, function(err, stack) {
        if (err) return cb(err);
        if (!stack) return cb(null);
        if (stack.status !== 'DELETE_COMPLETE') return cb(stack.status);
        cb(null);
      });
    });
  });
}
