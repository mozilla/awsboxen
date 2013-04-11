
const async = require('async');
const aws = require('awssum-amazon');
const CloudFormation = require('awssum-amazon-cloudformation').CloudFormation;

const SUCCESS_STATUSES = ['CREATE_COMPLETE'];
const FAILURE_STATUSES = [];

module.exports.getConnection = function getConnection(opts, cb) {
  var cfn = null;
  var err = null;
  try {
    cfn = new CloudFormation({
      accessKeyId: opts.aws_id || process.env.AWS_ID,
      secretAccessKey: opts.aws_secret || process.env.AWS_SECRET,
      region: opts.aws_region || aws.US_EAST_1
    });
  } catch (err) {}
  cb(err, cfn);
};


module.exports.deployStack = function deployStack(opts, cfg, cb) {
  module.exports.getConnection(opts, function(err, cfn) {
    if (err) return cb(err);

    // Fire up the stack creation process.
    // It'll take a while...
    cfn.CreateStack({
      StackName: opts.name,
      TemplateBody: JSON.stringify(cfg)
    }, function(err) {
      if (err) return cb(extractError(err)); 

      // Loop waiting for the stack to reach a steady state.
      // It may wind up completed or failed.
      var stackStatus = 'CREATE_IN_PROGRESS';
      async.whilst(function() {
        return (SUCCESS_STATUSES.indexOf(stackStatus) === -1 &&
                FAILURE_STATUSES.indexOf(stackStatus) === -1);
      }, function(cb) {
        cfn.DescribeStacks({ StackName: opts.name }, function(err, res) {
          if (err) return cb(extractError(err)); 
          res = res.Body.DescribeStacksResponse.DescribeStacksResult;
          stackStatus = res.Stacks.member.StackStatus;
          cb(null);
        });
      }, function(err) {
        if (err) return cb(err);
        if (FAILURE_STATUSES.indexOf(stackStatus) !== -1) {
          return cb(stackStatus);
        }
        cb(null);
      });
    });
  });
};

// Extract a useful error object.
// This peeks inside the awssum error response to return the actual body,
// but passes other error object through unchanged.
//
function extractError(err) {
  if (!err) return err;
  if (!err.Body) return err;
  return err.Body;
}
