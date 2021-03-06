/*jslint node: true */
/*jslint esversion: 6 */
"use strict";

const fs = require('fs');
const path = require('path');
const colors = require('colors');
const join = path.join;
const Combinatorics = require('js-combinatorics');
const normalizeHeader = require('header-case-normalizer');
const Monad = require('./monad');
const importHandler = require('./handlers/importHandler');
const headerHandler = require('./handlers/headerHandler');
const evalHandler = require('./handlers/evalHandler');
/**
 * Returns the status code out of the
 * first line of an HTTP response
 * (ie. HTTP/1.1 200 Ok)
 */
function parseStatus(header) {
  const regex = /(?<=HTTP\/\d.\d\s{1,1})(\d{3,3})(?=[a-z0-9\s]+)/gi;
  if (!regex.test(header)) throw new Error('Response code should be valid string');

  const res = header.match(regex);
  return res.join('');
}

/**
 * Parses an HTTP header, splitting
 * by colon.
 */
const parseHeader = function(header, context, request) {
  header = header.split(': ');

  return { key: normalizeHeader(header[0]), value: parseValue(header[1], context, request) };
};

const parseValue = function(value, context, request) {
  return Monad.of(value)
    .map((value) => importHandler(value, context, request))
    .map((value) => headerHandler(value, request))
    .map((value) => evalHandler(value, request))
    .join();
};

/**
 * Prepares headers to watch, no duplicates, non-blanks.
 * Priority exports over ENV definition.
 */
const prepareWatchedHeaders = function() {
  const exportHeaders = module.exports.headers && module.exports.headers.toString();
  const headers = (exportHeaders || process.env.MOCK_HEADERS || '').split(',');

  return headers.filter(function(item, pos, self) {
    return item && self.indexOf(item) == pos;
  });
};

/**
 * Combining the identically named headers
 */
const addHeader = function(headers, line) {
  const { key, value } = parseHeader(line);

  if (headers[key]) {
    headers[key] = [...(Array.isArray(headers[key]) ? headers[key] : [headers[key]]), value];
  } else {
    headers[key] = value;
  }
};

/**
 * Parser the content of a mockfile
 * returning an HTTP-ish object with
 * status code, headers and body.
 */
const parse = function(content, file, request) {
  const context = path.parse(file).dir + '/';
  const headers = {};
  let body;
  const bodyContent = [];
  content = content.split(/\r?\n/);
  const status = Monad.of(content[0])
    .map((value) => importHandler(value, context, request))
    .map((value) => evalHandler(value, context, request))
    .map(parseStatus)
    .join();

  let headerEnd = false;
  delete content[0];

  content.forEach(function(line) {
    switch (true) {
      case headerEnd:
        bodyContent.push(line);
        break;
      case line === '' || line === '\r':
        headerEnd = true;
        break;
      default:
        addHeader(headers, line);
        break;
    }
  });

  body = Monad.of(bodyContent.join('\n'))
    .map((value) => importHandler(value, context, request))
    .map((value) => evalHandler(value, context, request))
    .join();

  return { status: status, headers: headers, body: body };
};

function removeBlanks(array) {
  return array.filter(function(i) {
    return i;
  });
}

/**
 * This method will look for a header named Response-Delay. When set it
 * delay the response in that number of milliseconds simulating latency
 * for HTTP calls.
 *
 * Example from a file:
 *   Response-Delay: 5000
 *
 * @param {mock.headers} headers : {
 *     'Response-Delay': is the property name,
 *     'value': Positive integer value
 */
const getResponseDelay = function(headers) {
  if (headers && headers.hasOwnProperty('Response-Delay')) {
    let delayVal = parseInt(headers['Response-Delay'], 10);
    delayVal = isNaN(delayVal) || delayVal < 0 ? 0 : delayVal;
    return delayVal;
  }
  return 0;
};

function getWildcardPath(dir) {
  let steps = removeBlanks(dir.split('/'));
  let testPath;
  let newPath;
  let exists = false;

  while (steps.length) {
    steps.pop();
    testPath = join(steps.join('/'), '/__');
    exists = fs.existsSync(join(mockserver.directory, testPath));
    if (exists) {
      newPath = testPath;
    }
  }

  const res = getDirectoriesRecursive(mockserver.directory)
    .filter((dir) => {
      const directories = dir.split(path.sep);
      return directories.includes('__');
    })
    .sort((a, b) => {
      const aLength = a.split(path.sep);
      const bLength = b.split(path.sep);

      if (aLength == bLength) return 0;

      // Order from longest file path to shortest.
      return aLength > bLength ? -1 : 1;
    })
    .map((dir) => {
      const steps = dir.split(path.sep);
      const baseDir = mockserver.directory.split(path.sep);
      steps.splice(0, baseDir.length);
      return steps.join(path.sep);
    });

  steps = removeBlanks(dir.split('/'));

  newPath = matchWildcardPaths(res, steps) || newPath;

  return newPath;
}

function matchWildcardPaths(res, steps) {
  for (let resIndex = 0; resIndex < res.length; resIndex++) {
    const dirSteps = res[resIndex].split(/\/|\\/);
    if (dirSteps.length !== steps.length) {
      continue;
    }
    const result = matchWildcardPath(steps, dirSteps);
    if (result) {
      return result;
    }
  }
  return null;
}

function matchWildcardPath(steps, dirSteps) {
  for (let stepIndex = 1; stepIndex <= steps.length; stepIndex++) {
    const step = steps[steps.length - stepIndex];
    const dirStep = dirSteps[dirSteps.length - stepIndex];
    if (step !== dirStep && dirStep != '__') {
      return null;
    }
  }
  return '/' + dirSteps.join('/');
}

function flattenDeep(directories) {
  return directories.reduce(
    (acc, val) => (Array.isArray(val) ? acc.concat(flattenDeep(val)) : acc.concat(val)),
    []
  );
}

function getDirectories(srcpath) {
  return fs
    .readdirSync(srcpath)
    .map((file) => path.join(srcpath, file))
    .filter((path) => fs.statSync(path).isDirectory());
}

function getDirectoriesRecursive(srcpath) {
  const nestedDirectories = getDirectories(srcpath).map(getDirectoriesRecursive);
  const directories = flattenDeep(nestedDirectories);
  directories.push(srcpath);
  return directories;
}

/**
 * Returns the body or query string to be used in
 * the mock fileName.
 *
 * In any case we will prepend the value with a double
 * dash so that the mock files will look like:
 *
 * POST--My-Body=123.mock
 *
 * or
 *
 * GET--query=string&hello=hella.mock
 */
function getBodyOrQueryString(body, query) {
  if (body && query) {
    return '_'+ body + '--' + query;
  }

  if (query) {
    return '--' + query;
  }

  if (body && body !== '') {
    return '--' + body;
  }

  return body;
}

/**
 * Ghetto way to get the body
 * out of the request.
 *
 * There are definitely better
 * ways to do this (ie. npm/body
 * or npm/body-parser) but for
 * the time being this does it's work
 * (ie. we don't need to support
 * fancy body parsing in mockserver
 * for now).
 */
function getBody(req, callback) {
  let body = '';

  req.on('data', function(b) {
    body = body + b.toString();
  });

  req.on('end', function() {
    callback(body);
  });
}

function isJsonString(str) {
  if (typeof str !== 'string') {
    return false;
  }
  try {
    JSON.parse(str);
  } catch (err) {
    return false;
  }
  return true;
}

function getMatchingJsonFile(files, fullPath, jsonBody) {
  for (var file of files) {
    if (file.endsWith('.json')) {
      var data = fs.readFileSync(join(fullPath, file), { encoding: 'utf8' });

      try {
        if (JSON.stringify(JSON.parse(jsonBody)) === JSON.stringify(JSON.parse(data))) {
          if (mockserver.verbose) {
            console.log('Payload in ' + join(fullPath, file).yellow + " file: " + 'Matched'.green);
          }
          return file;
        } else {
          if (mockserver.verbose) {
            console.log('Payload in ' + join(fullPath, file).yellow + " file: " +  'Not matched'.red);
          }
        }
      } catch (err) {
        if (mockserver.verbose) {
          console.log(
            'Tried to match json body with ' + file.yellow + '. File has invalid JSON'.red
          );
        }
      }
    }
  }
  return null;
}

function getMockedContent(path, prefix, body, query) {
  
  // Check for an exact match
  const exactName = prefix + (getBodyOrQueryString(body, query) || '') + '.mock';
  let content = handleMatch(path, exactName, fs.existsSync);

  //Check for body match
  if (!content) {
    content = testForBody(path, prefix, body, query, false);
  }

  // Compare params without regard to order
  if (!content && query) {
    content = testForQuery(path, prefix, body, query, false);

    // Compare params without regard to order and allow wildcards
    if (!content) {
      content = testForQuery(path, prefix, body, query, true);
    }
  }

  // fallback option (e.g. GET.mock). ignores body and query
  if (!content) {
    const fallbackName = prefix + '.mock';
    content = handleMatch(path, fallbackName, fs.existsSync);
  }

  return content;
}

/*
 * Matches mocks such as POST@payload.mock, where the body posted matches
 * the content of the file payload as indicated by @
 */
function testForBody(path, prefix, body, query, allowWildcards) {
  
  var fullPath = join(mockserver.directory, path);
  if (fs.existsSync(fullPath)) {
    var files = fs.readdirSync(fullPath);

    if (body && isJsonString(body)) {
      var matchingJsonFile = getMatchingJsonFile(files, fullPath, body);

      if (matchingJsonFile) {
        var fileWithoutExtension = matchingJsonFile.replace('.json', '');
        var mockNameFromJson = prefix + '@' + fileWithoutExtension + '.mock';
        
        return handleMatch(path, mockNameFromJson, fs.existsSync);
      } 
    }
  }
  
}

function testForQuery(path, prefix, body, query, allowWildcards) {
  
  if (!fs.existsSync(join(mockserver.directory, path))) {
    return handleMatch(path, join(mockserver.directory, path), false);
  }

  // Find all files in the directory
  return fs
    .readdirSync(join(mockserver.directory, path))
    .filter(possibleFile => {
      if (body) {
        return possibleFile.startsWith(prefix + '_' + body) && possibleFile.endsWith('.mock');
      }

      return possibleFile.startsWith(prefix) && possibleFile.endsWith('.mock');
    })
    .filter(possibleFile => possibleFile.match(/--[\s\S]*__/))
    .reduce((prev, possibleFile) => {
      if (prev) {
        return prev;
      }

      //get params from file
      const paramMap = queryStringToMap(query);
      const possibleFileParamMap = queryStringToMap(
        possibleFile.replace('.mock', '').split('--')[1]
      );

      let isMatch = true;
      for (const key in paramMap) { //Match each parameter against value or wildacard
        if (!isMatch) {
          break;
        }
        if (possibleFileParamMap[key] === paramMap[key]) {
          //The parameter matched the value exactly
          continue;
        } 
        
        if (allowWildcards) {

          if (key in possibleFileParamMap) {
            //The parameter was configured to accept any value
            isMatch = possibleFileParamMap[key] === '__';
          } else {
            if (possibleFileParamMap['__'] === '__') {
              //The mock was configured to accept any parameter with any value
              continue;
            } else {
              isMatch = false;
            }
          } 

        } else {
          isMatch = false;
        }
         
      }

      return handleMatch(path, possibleFile, isMatch);
    }, undefined);
}

function queryStringToMap(query) {
  const result = {};
  query.split('&').forEach(param => {
    const [key, val] = param.split('=');
    result[key] = val;
  });
  return result;
}

function handleMatch(path, fileName, isMatchOrTest) {
  const mockFile = join(mockserver.directory, path, fileName);

  let isMatch = isMatchOrTest;
  if (typeof isMatchOrTest === 'function') {
    isMatch = isMatchOrTest(mockFile);
  }

  if (isMatch) {
    if (mockserver.verbose) {
      console.log('Reading from ' + mockFile.yellow + ' file: ' + 'Matched'.green);
    }
    return fs.readFileSync(mockFile, { encoding: 'utf8' });
  }
  

  if (mockserver.verbose) {
    console.log('Reading from ' + mockFile.yellow + ' file: ' + 'Not matched'.red);
  }
 
}

function getContentFromPermutations(path, method, body, query, permutations) {
  let content, prefix;

  while (permutations.length) {
    prefix = method + permutations.pop().join('');
    content = getMockedContent(path, prefix, body, query) || content;
  }

  return { content: content, prefix: prefix };
}

const mockserver = {
  directory: '.',
  verbose: false,
  headers: [],
  init: function(directory, verbose) {
    this.directory = directory;
    this.verbose = !!verbose;
    this.headers = prepareWatchedHeaders();
  },
  handle: function(req, res) {
    getBody(req, function(body) {
      req.body = body;
      const url = req.url;
      let path = url;

      const queryIndex = url.indexOf('?'),
        query = queryIndex >= 0 ? url.substring(queryIndex).replace(/\?/g, '') : '',
        method = req.method.toUpperCase(),
        headers = [];

      if (queryIndex > 0) {
        path = url.substring(0, queryIndex);
      }

      if (req.headers && mockserver.headers.length) {
        mockserver.headers.forEach(function(header) {
          header = header.toLowerCase();
          if (req.headers[header]) {
            headers.push('_' + normalizeHeader(header) + '=' + req.headers[header]);
          }
        });
      }

      // Now, permute the possible headers, and look for any matching files, prioritizing on
      // both # of headers and the original header order
      let matched,
        permutations = [[]];

      if (headers.length) {
        permutations = Combinatorics.permutationCombination(headers)
          .toArray()
          .sort(function(a, b) {
            return b.length - a.length;
          });
        permutations.push([]);
      }

      matched = getContentFromPermutations(path, method, body, query, permutations.slice(0));

      if (!matched.content && (path = getWildcardPath(path))) {
        matched = getContentFromPermutations(path, method, body, query, permutations.slice(0));
      }

      if (matched.content) {
        const mock = parse(matched.content, join(mockserver.directory, path, matched.prefix), req);
        const delay = getResponseDelay(mock.headers);
        if (delay > 0) {
          setTimeout(function() {
            res.writeHead(mock.status, mock.headers);
            res.end(mock.body);
          }, delay);
        } else {
          res.writeHead(mock.status, mock.headers);
          return res.end(mock.body);
        }
      } else {
        res.writeHead(404);
        res.end('Not Mocked');
      }
    });
  }
};

module.exports = function(directory, silent) {
  mockserver.init(directory, silent);

  return mockserver.handle;
};

module.exports.headers = null;
module.exports.getResponseDelay = getResponseDelay;
