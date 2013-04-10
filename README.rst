Deploy and Scale NodeJS Applications in AWS
===========================================

This is an experiment in automating deployment and scaling of NodeJS
applications.  It lets you declare the structure of your deployment right
next to your app and instantly push it into the cloud, as anything from a
single server through to a highly complex cluster.

It uses Amazon Web Services for hosting, Amazon CloudFormation to describe
a deployment, and awsbox for all the fiddly NodeJS deployment bits:

  * http://awsbox.org/
  * http://aws.amazon.com/cloudformation/

You might like to think of it as "awsbox on steroids".
Legal, harmful-side-effect-free steroids.


Quickstart
----------

The awsboxen process in a nutshell:

  0)  Store your code in git.  We assume you're working from a git checkout.
  1)  Create a ".awsboxen.json" file at the top level of your project.
  2)  Populate it with awsbox and CloudFormation configuration data
  3)  Run "awsboxen deploy".
  4)  Relax as your app is effortlessly deployed to the cloud.


The ".awsboxen.json" document describes the entire structure of the deployment.
It includes awsbox config to specify the code and processes that should be run,
and CloudFormation config to specify the physical resources on which to run
them.


Managing a Deployment
---------------------

All deployment managment is done through the "awsboxen" command-line client.
Here are the major modes of operation:


**awsboxen deploy [--profile=PROFILE] <name> [<ref>]**

This command lets you deploy a new version of your code into the cloud.  You
specify an optional deployment profile, a unique name for this particular
deployment, and an optional git references giving the version of the code
to deploy.

This command will:

  * Checkout the appropriate ref and load its .awsboxen.json file.
  * Find all the declared boxen, and use awsbox to create an AMI for each
    with the appropriate version of the code.
  * Serialize the CloudFormation description and pass it up to AWS to
    create or update the deployment.
  * Wait until the deployment has completed, and report success or failure.

The same command works for creating a new deployment and updating an exsiting
deployment to a new code version.  Amazon CloudFormation has strong support
for making safe updates to an existing deployment, as described here:

  http://aws.amazon.com/about-aws/whats-new/2011/09/29/aws-cloudformation-new-features-update-stack-and-iam-support/

So this approach allows you to version-control your evolving deployment stack
right alongside the actual code.  New version adds another type of server?
No problem, CloudFormation will take care of it.


**awsboxen list [--profile=PROFILE]**

This command will list the name of all current deployment stacks.  You can
optionally filter for just those stacks deployed at a specific profile.


**awsboxen info <name>**

This command gets information about a current deployment stack, including:

  * status of the stack
  * git SHA1 and reference tag for the currently deployed version
  * any "outputs" declared in the CloudFormation config


**awsboxen teardown <name>**

This command destroys a deployment stack, deallocating all the corresponding
AWS resources.  It's very highly descructive and cannot be undone, so due
care should be taken!


Describing a Deployment
-----------------------

The structure of your AWS deployment is described using the AWS CloudFormation
language, with some shortcuts and helpers to make things a little more
convenient.

Conceptually, you provide a file ".awsboxen.json" with a full description
of the desired deployment structure - all machine images, load balancers,
databases, everything.  But that can be pretty complicated, so let's work
up to it slowly.  Here's the simplest possible ".awsboxen.json" file::


    {
      "processes": [ "server.js "]
    }

Yes, this is just an awsbox deployment file!  At deploy time awsboxen will
fill in some sensible defaults, assuming that you want a single all-in-one
server instance like you'd get from vanilla awsbox.  It will expand the 
description into something like the following::

    {
      // Description automatically generated from repo name.

      "Description": "example-server deployment",

      // Enumerates the different types of boxen in this deployment.
      // Each entry is an awsbox configuration, which will be frozen into
      // an AMI and can be referenced in the "Resources" section.
      //
      // In this case, we have only a single type of box.

      "Boxen": {
        "WebServer": {
          { "processes": [ "server.js "] }
        }
      },

      // Enumerates the physical resources that make up the deployent.
      // This might include a load balancer, a database instance, and some
      // EC2 instances running boxen that were defined above.
      //
      // In this case we have a single server instance.

      "Resources": {
        "WebHead": {
          "Type": "AWS::EC2::Instance",
          "Properties": {
            "InstanceType": "m1.small",
            "ImageId": {"Ref": "Boxen::WebServer::ImageId" },
          }
        }
      }

    }


As your needs grow, you can fill in more and more of the deployment description
manually rather than relying on the defaults.

You can also create multiple deployment profiles (e.g. one for dev, one for
production) by populating the key "Profiles" with additional CloudFormation
configs.  It will be merged into the main configuration when that profile
is selected::

    {

      "Boxen": { "WebHead": { "processes": [ "server.js "] } },

      //  By default we use a small instance, for development purposes.

      "Resources": {
        "WebHead": {
          "Type": "AWS::EC2::Instance",
          "Properties": {
            "InstanceType": "m1.small",
            "ImageId": {"Ref": "Boxen::WebServer::ImageId" },
          }
        }
      },

      //  But we use a large instance when running in production.

      "Profiles" {
        "Production": {
          "Resources": { "WebHead": { "Properties": {
            "InstanceType": "m1.large"
          }}}
        }
      }
      
    }

The CloudFormation language can be pretty cumbersome, so we offer some handy
shortcuts.  You can use YAML instead of JSON, and if you specify a file
instead of a directory then it will be as a dict with keys corresponding to
child names.  The above example could be produced from a directory structure
like this::

    .awsboxen/
        Description.yaml
        Resources.yaml
        Boxen/
           WebHead.json
        Profiles/
           Production.json

