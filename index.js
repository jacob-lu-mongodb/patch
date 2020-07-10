#!/usr/bin/env node

const http = require('http');
const fs = require('fs');
const jsYaml = require('js-yaml');
const qs = require('querystring');
const keychain = require('keychain');
const {Octokit} = require("@octokit/rest");
const {exec} = require('child_process');
const branch = require('git-branch');
const Prompt = require('prompt-password');
const opn = require('opn');

const evgProjName = 'mms';
const localProjDir = '/Users/jacoblu/proj/mms'; // TODO
const gitRepoName = 'mms';
const gitRepoOwner = '10gen';

const evgYamlFileName = '.evergreen.yml';
const evgBuildVariant = 'e2e_backup_cps';

const patchHeader = '*** PATCHES ***';

const port = 8081;

const args = process.argv.slice(2);

// TODO doc: npm link
switch (args[0]) {
  case 'create':
    create();
    break;

  case 'check':
    check(args[1]);
    break;

  default:
    console.error('Unsupported mode');
}

function getEvgTaskNames() {
  const evgYamlPath = `${localProjDir}/${evgYamlFileName}`;
  const evgYamlFile = fs.readFileSync(evgYamlPath, 'utf8');

  const yamlDoc = jsYaml.safeLoad(evgYamlFile);

  return yamlDoc.tasks.filter(
      t => (t.tags || []).includes(evgBuildVariant)).map(t => t.name);
}

function createPatch(taskName, description) {
  const patchCmd = `evergreen patch -p ${evgProjName} -v ${evgBuildVariant} -t ${taskName} -d ${description} -y -u -f`;

  return new Promise((resolve) => {
    exec(patchCmd, {cwd: localProjDir}, (err, stdout, stderr) => {
      if (err) {
        throw new Error(
            `Error submitting patch for ${taskName}:\n output: ${stdout}\n error: ${stderr}`);
      }
      const patchId = stdout.match('ID : ([a-z0-9]+)')[1];
      resolve(patchId);
    });
  });
}

async function getPr(cloudpNumber) {
  const octokit = await getOctokit();
  const branchName = cloudpNumber ? `CLOUDP-${cloudpNumber}` : await getBranchName();

  const prs = await octokit.search.issuesAndPullRequests({
    q: `is:pr is:open repo:10gen/mms head:${branchName}`
  });

  if (prs.data.total_count !== 1) {
    throw new Error('PR not found or ambiguous');
  }

  return prs.data.items[0];
}

async function getOctokit() {
  return new Octokit({
    auth: await getGithubToken()
  });
}

function generatePrComment(patchObjects) {
  return `${patchHeader}\n${JSON.stringify(patchObjects, null, 2)}`;
}

async function createPrComment(patchObjects) {
  const octokit = await getOctokit();
  const comment = generatePrComment(patchObjects);

  await octokit.issues.createComment({
    owner: gitRepoOwner,
    repo: gitRepoName,
    issue_number: (await getPr()).number,
    body: comment
  });
}

function writeFormResponse(response, taskNames) {
  response.writeHeader(200, {"Content-Type": "text/html"});
  response.write(
      `<form method="POST" 
        onsubmit="
          setTimeout(() => 
            document.getElementsByTagName('body')[0].innerHTML = '<h1>Please wait...</h1>', 10
          ); 
          return true;"
      >`);

  for (const task of taskNames) {
    response.write('<div>');
    response.write(`<input type="checkbox" name="${task}"`);
    response.write(`<label for="${task}">${task}</label>`);
    response.write('</div>');
  }

  response.write('<br>');
  response.write('<input type="submit" value="Submit">');
  response.write('</form>');
  response.end();
}

async function writeDoneResponse(response) {
  const prIssue = await getPr();
  response.writeHeader(303, {"Location": prIssue.html_url});
  response.end();
}

function getSubmittedTaskNames(req) {
  let body = '';

  req.on('data', function (data) {
    body += data;
  });

  return new Promise((resolve) => {
    req.on('end', function () {
      const post = qs.parse(body);

      const taskNames = Object.keys(post).filter(key => post[key] === 'on');
      resolve(taskNames);
    });
  });
}

async function getGithubToken() {
  const keychainServiceName = 'github';
  const keychainAccountName = 'token';

  return new Promise(resolve => {
    keychain.getPassword(
        {account: keychainAccountName, service: keychainServiceName},
        function (err, pass) {
          if (err) {
            console.log(`Error retrieving Github token from keychain: ${err}`);

            const prompt = new Prompt({
              type: 'password',
              message: 'Enter your Github token',
              name: 'token'
            });

            prompt.run()
            .then(function (token) {
              keychain.setPassword({
                    account: keychainAccountName,
                    service: keychainServiceName,
                    password: token
                  },
                  function (err) {
                    if (err) {
                      throw new Error(
                          `Error saving Github token in keychain: ${err}`);
                    } else {
                      console.log("Github token saved to keychain");
                    }
                  });

              resolve(token);
            });
          } else {
            resolve(pass);
          }
        });
  });
}

async function getBranchName() {
  return branch(localProjDir);
}

async function createPatches(taskNames) {
  return await Promise.all(taskNames.map(async taskName => {
    const patchDescription = `${await getBranchName()}_${taskName}_${new Date().getTime()}`;
    const patchId = await createPatch(taskName, patchDescription);

    const patchUrl = `https://evergreen.mongodb.com/patch/${patchId}`;
    const link = `[${patchUrl}](${patchUrl})`;
    return {task: taskName, patchId, link};
  }));
}

function create() {
  const server = http.createServer(async (req, res) => {
    if (req.method === 'POST') {
      const taskNames = await getSubmittedTaskNames(req);

      const patchObjects = await createPatches(taskNames);

      await createPrComment(patchObjects);

      await writeDoneResponse(res);

      server.close();
      console.log("Server closed");
    } else {
      writeFormResponse(res, getEvgTaskNames());
    }
  });

  server.listen(port);

  opn(`http://localhost:${port}`);
}

async function check(cloudpNumber) {
  const octokit = await getOctokit();

  const comments = await octokit.issues.listComments({
    owner: gitRepoOwner,
    repo: gitRepoName,
    issue_number: (await getPr(cloudpNumber)).number,
    per_page: 100
  });

  comments.data.forEach(processComment);
}

function getPatchStatus(patchId) {
  const patchCmd = `evergreen list-patches -i ${patchId}`;

  return new Promise((resolve) => {
    exec(patchCmd, (err, stdout, stderr) => {
      if (err) {
        throw new Error(
            `Error checking patch status for ${patchId}:\n output: ${stdout}\n error: ${stderr}`);
      }
      const status = stdout.match('Status : ([a-z]+)')[1];
      resolve(status);
    });
  });
}

async function processComment(comment) {
  if (!comment.body.startsWith(patchHeader)) {
    return;
  }

  let modified = false;
  const patchObjects = JSON.parse(comment.body.replace(patchHeader, ''));

  await Promise.all(patchObjects.map(async patch => {
    if (['succeeded', 'failed'].includes(patch.status)) {
      return;
    }
    patch.status = await getPatchStatus(patch.patchId);
    modified = true;
  }));

  if (modified) {
    const octokit = await getOctokit();

    await octokit.issues.updateComment({
      owner: gitRepoOwner,
      repo: gitRepoName,
      comment_id: comment.id,
      body: generatePrComment(patchObjects),
    });
  }
}