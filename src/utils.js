import contentTypeParser from 'content-type';
import os from 'os';
import fs from 'fs';
import util from 'util';
import fsExtra from 'fs-extra';
import ApifyClient from 'apify-client';
import psTree from '@apify/ps-tree';
import requestPromise from 'request-promise-native';
import XRegExp from 'xregexp';
import cheerio from 'cheerio';
import { delayPromise, getRandomInt } from 'apify-shared/utilities';
import { ENV_VARS, LOCAL_ENV_VARS } from 'apify-shared/consts';
import { checkParamOrThrow } from 'apify-client/build/utils';
import { USER_AGENT_LIST } from './constants';

/* globals process */


/**
 * Default regular expression to match URLs in a string that may be plain text, JSON, CSV or other. It supports common URL characters
 * and does not support URLs containing commas or spaces. The URLs also may contain Unicode letters (not symbols).
 * @memberOf utils
 */
const URL_NO_COMMAS_REGEX = XRegExp('https?://(www\\.)?[\\p{L}0-9][-\\p{L}0-9@:%._\\+~#=]{0,254}[\\p{L}0-9]\\.[a-z]{2,63}(:\\d{1,5})?(/[-\\p{L}0-9@:%_\\+.~#?&//=\\(\\)]*)?', 'gi'); // eslint-disable-line
/**
 * Regular expression that, in addition to the default regular expression `URL_NO_COMMAS_REGEX`, supports matching commas in URL path and query.
 * Note, however, that this may prevent parsing URLs from comma delimited lists, or the URLs may become malformed.
 * @memberOf utils
 */
const URL_WITH_COMMAS_REGEX = XRegExp('https?://(www\\.)?[\\p{L}0-9][-\\p{L}0-9@:%._\\+~#=]{0,254}[\\p{L}0-9]\\.[a-z]{2,63}(:\\d{1,5})?(/[-\\p{L}0-9@:%_\\+,.~#?&//=\\(\\)]*)?', 'gi'); // eslint-disable-line

const ensureDirPromised = util.promisify(fsExtra.ensureDir);
const psTreePromised = util.promisify(psTree);

/**
 * Creates an instance of ApifyClient using options as defined in the environment variables.
 * This function is exported to enable unit testing.
 *
 * @returns {*}
 * @ignore
 */
export const newClient = () => {
    const opts = {
        userId: process.env[ENV_VARS.USER_ID] || null,
        token: process.env[ENV_VARS.TOKEN] || null,
    };

    // Only set baseUrl if overridden by env var, so that 'https://api.apify.com' is used by default.
    // This simplifies local development, which should run against production unless user wants otherwise.
    const apiBaseUrl = process.env[ENV_VARS.API_BASE_URL];
    if (apiBaseUrl) opts.baseUrl = apiBaseUrl;

    return new ApifyClient(opts);
};

/**
 * Gets the default instance of the `ApifyClient` class provided
 * <a href="https://www.apify.com/docs/sdk/apify-client-js/latest"
 * target="_blank">apify-client</a> by the NPM package.
 * The instance is created automatically by the Apify SDK and it is configured using the
 * `APIFY_API_BASE_URL`, `APIFY_USER_ID` and `APIFY_TOKEN` environment variables.
 *
 * The instance is used for all underlying calls to the Apify API in functions such as
 * [`Apify.getValue()`](#module_Apify.getValue) or [`Apify.call()`](#module_Apify.call).
 * The settings of the client can be globally altered by calling the
 * <a href="https://www.apify.com/docs/sdk/apify-client-js/latest#ApifyClient-setOptions"
 * target="_blank">`Apify.client.setOptions()`</a> function.
 * Beware that altering these settings might have unintended effects on the entire Apify SDK package.
 *
 * @memberof module:Apify
 * @name client
 */
export const apifyClient = newClient();

/**
 * Returns a result of `Promise.resolve()`.
 *
 * @returns {*}
 *
 * @ignore
 */
export const newPromise = () => {
    return Promise.resolve();
};

/**
 * Adds charset=utf-8 to given content type if this parameter is missing.
 *
 * @param {String} contentType
 * @returns {String}
 *
 * @ignore
 */
export const addCharsetToContentType = (contentType) => {
    if (!contentType) return contentType;

    const parsed = contentTypeParser.parse(contentType);

    if (parsed.parameters.charset) return contentType;

    parsed.parameters.charset = 'utf-8';

    return contentTypeParser.format(parsed);
};

let isDockerPromiseCache;
const createIsDockerPromise = () => {
    const promise1 = util
        .promisify(fs.stat)('/.dockerenv')
        .then(() => true)
        .catch(() => false);

    const promise2 = util
        .promisify(fs.readFile)('/proc/self/cgroup', 'utf8')
        .then(content => content.indexOf('docker') !== -1)
        .catch(() => false);

    return Promise
        .all([promise1, promise2])
        .then(([result1, result2]) => result1 || result2);
};

/**
 * Returns a `Promise` that resolves to true if the code is running in a Docker container.
 *
 * @return {Promise}
 *
 * @memberof utils
 * @name isDocker
 * @function
 */
export const isDocker = (forceReset) => {
    // Parameter forceReset is just internal for unit tests.
    if (!isDockerPromiseCache || forceReset) isDockerPromiseCache = createIsDockerPromise();

    return isDockerPromiseCache;
};

/**
 * Sums an array of numbers.
 *
 * @param {Array} arr An array of numbers.
 * @return {Number} Sum of the numbers.
 *
 * @ignore
 */
export const sum = arr => arr.reduce((total, c) => total + c, 0);

/**
 * Computes an average of an array of numbers.
 *
 * @param {Array} arr An array of numbers.
 * @return {Number} Average value.
 *
 * @ignore
 */
export const avg = arr => sum(arr) / arr.length;

/**
 * Computes a weighted average of an array of numbers, complemented by an array of weights.
 *
 * @param {Array} arrValues
 * @param {Array} arrWeights
 * @return {Number}
 *
 * @ignore
 */
export const weightedAvg = (arrValues, arrWeights) => {
    const result = arrValues.map((value, i) => {
        const weight = arrWeights[i];
        const sum = value * weight; // eslint-disable-line no-shadow

        return [sum, weight];
    }).reduce((p, c) => [p[0] + c[0], p[1] + c[1]], [0, 0]);

    return result[0] / result[1];
};

/**
 * Returns memory statistics of the process and the system, which is an object with the following properties:
 *
 * ```javascript
 * {
 *   // Total memory available in the system or container
 *   totalBytes: Number,
 *   // Amount of free memory in the system or container
 *   freeBytes: Number,
 *   // Amount of memory used (= totalBytes - freeBytes)
 *   usedBytes: Number,
 *   // Amount of memory used the current Node.js process
 *   mainProcessBytes: Number,
 *   // Amount of memory used by child processes of the current Node.js process
 *   childProcessesBytes: Number,
 * }
 * ```
 *
 * If the process runs inside of Docker, the `getMemoryInfo` gets container memory limits,
 * otherwise it gets system memory limits.
 *
 * Beware that the function is quite inefficient because it spawns a new process.
 * Therefore you shouldn't call it too often, like more than once per second.
 *
 * @returns {Promise<Object>}
 *
 * @memberof module:Apify
 * @name getMemoryInfo
 * @function
 */
export const getMemoryInfo = async () => {
    const [isDockerVar, processes] = await Promise.all([
        // module.exports must be here so that we can mock it.
        module.exports.isDocker(),
        // Query both root and child processes
        psTreePromised(process.pid, true),
    ]);

    let mainProcessBytes = -1;
    let childProcessesBytes = 0;
    processes.forEach((rec) => {
        // Skip the 'ps' or 'wmic' commands used by ps-tree to query the processes
        if (rec.COMMAND === 'ps' || rec.COMMAND === 'WMIC.exe') {
            return;
        }
        const bytes = parseInt(rec.RSS, 10);
        // Obtain main process' memory separately
        if (rec.PID === `${process.pid}`) {
            mainProcessBytes = bytes;
            return;
        }
        childProcessesBytes += bytes;
    });

    let totalBytes;
    let freeBytes;
    let usedBytes;

    if (!isDockerVar) {
        totalBytes = os.totalmem();
        freeBytes = os.freemem();
        usedBytes = totalBytes - freeBytes;
    } else {
        // When running inside Docker container, use container memory limits
        // This must be promisified here so that we can mock it.
        const readPromised = util.promisify(fs.readFile);

        const [totalBytesStr, usedBytesStr] = await Promise.all([
            readPromised('/sys/fs/cgroup/memory/memory.limit_in_bytes'),
            readPromised('/sys/fs/cgroup/memory/memory.usage_in_bytes'),
        ]);

        totalBytes = parseInt(totalBytesStr, 10);
        usedBytes = parseInt(usedBytesStr, 10);
        freeBytes = totalBytes - usedBytes;
    }

    return {
        totalBytes,
        freeBytes,
        usedBytes,
        mainProcessBytes,
        childProcessesBytes,
    };
};

/**
 * Helper function that determines if given parameter is an instance of Promise.
 *
 * @ignore
 */
export const isPromise = (maybePromise) => {
    return maybePromise && typeof maybePromise.then === 'function' && typeof maybePromise.catch === 'function';
};

/**
 * Returns true if node is in production environment and false otherwise.
 *
 * @ignore
 */
export const isProduction = () => process.env.NODE_ENV === 'production';

/**
 * Helper function used for local implementations. Creates dir.
 *
 * @ignore
 */
export const ensureDirExists = path => ensureDirPromised(path);

/**
 * Helper function that returns the first key from plan object.
 *
 * @ignore
 */
export const getFirstKey = (dict) => {
    for (const key in dict) { // eslint-disable-line guard-for-in, no-restricted-syntax
        return key;
    }
};

/**
 * Gets a typical path to Chrome executable, depending on the current operating system.
 *
 * @return {string}
 * @ignore
 */
export const getTypicalChromeExecutablePath = () => {
    switch (os.platform()) {
    case 'darwin': return '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    case 'win32': return 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe';
    default: return 'google-chrome';
    }
};

/**
 * Wraps the provided Promise with another one that rejects with the given errorMessage
 * after the given timeoutMillis, unless the original promise resolves or rejects earlier.
 *
 * @param {Promise} promise
 * @param {number} timeoutMillis
 * @param {string} errorMessage
 * @ignore
 */
export const addTimeoutToPromise = (promise, timeoutMillis, errorMessage) => {
    return new Promise((resolve, reject) => {
        if (!isPromise(promise)) throw new Error('Parameter promise of type Promise must be provided.');
        checkParamOrThrow(timeoutMillis, 'timeoutMillis', 'Number');
        checkParamOrThrow(errorMessage, 'errorMessage', 'String');

        const timeout = setTimeout(() => reject(new Error(errorMessage)), timeoutMillis);
        promise.then((data) => {
            clearTimeout(timeout);
            resolve(data);
        }, (reason) => {
            clearTimeout(timeout);
            reject(reason);
        });
    });
};

/**
 * Creates a promise that after given time gets rejected with given error.
 *
 * @return {Promise<Error>}
 * @ignore
 */
export const createTimeoutPromise = (timeoutMillis, errorMessage) => {
    return delayPromise(timeoutMillis).then(() => {
        throw new Error(errorMessage);
    });
};

/**
 * Returns `true` when code is running on Apify platform and `false` otherwise (for example locally).
 *
 * @returns {Boolean}
 *
 * @memberof module:Apify
 * @name isAtHome
 * @function
 */
export const isAtHome = () => !!process.env[ENV_VARS.IS_AT_HOME];

/**
 * Returns a `Promise` that resolves after a specific period of time. This is useful to implement waiting
 * in your code, e.g. to prevent overloading of target website or to avoid bot detection.
 *
 * **Example usage:**
 *
 * ```
 * const Apify = require('apify');
 *
 * ...
 *
 * // Sleep 1.5 seconds
 * await Apify.utils.sleep(1500);
 * ```
 * @param {Number} millis Period of time to sleep, in milliseconds. If not a positive number, the returned promise resolves immediately.
 * @memberof utils
 * @return {Promise}
 */
const sleep = (millis) => {
    return delayPromise(millis);
};

/**
 * Returns a promise that resolves to an array of urls parsed from the resource available at the provided url.
 * Optionally, custom regular expression and encoding may be provided.
 *
 * @param {Object} options
 * @param {String} options.url URL to the file
 * @param {String} [options.encoding='utf8'] The encoding of the file.
 * @param {RegExp} [options.urlRegExp=URL_NO_COMMAS_REGEX]
 *   Custom regular expression to identify the URLs in the file to extract.
 *   The regular expression should be case-insensitive and have global flag set (i.e. `/something/gi`).
 * @returns {Promise<String[]>}
 * @memberOf utils
 */
const downloadListOfUrls = async ({ url, encoding = 'utf8', urlRegExp = URL_NO_COMMAS_REGEX }) => {
    checkParamOrThrow(url, 'url', 'String');
    checkParamOrThrow(encoding, 'string', 'String');
    checkParamOrThrow(urlRegExp, 'urlRegExp', 'RegExp');

    const string = await requestPromise.get({ url, encoding });
    return extractUrls({ string, urlRegExp });
};

/**
 * Collects all URLs in an arbitrary string to an array, optionally using a custom regular expression.
 * @param {String} string
 * @param {RegExp} [urlRegExp=Apify.utils.URL_NO_COMMAS_REGEX]
 * @returns {String[]}
 * @memberOf utils
 */
const extractUrls = ({ string, urlRegExp = URL_NO_COMMAS_REGEX }) => {
    checkParamOrThrow(string, 'string', 'String');
    checkParamOrThrow(urlRegExp, 'urlRegExp', 'RegExp');
    return string.match(urlRegExp) || [];
};

/**
 * Returns a randomly selected User-Agent header out of a list of the most common headers.
 * @returns {String}
 * @memberOf utils
 */
const getRandomUserAgent = () => {
    const index = getRandomInt(USER_AGENT_LIST.length);
    return USER_AGENT_LIST[index];
};

/**
 * Helper function to open local storage.
 *
 * @ignore
 */
export const openLocalStorage = async (idOrName, defaultIdEnvVar, LocalClass, cache) => {
    const localStorageDir = process.env[ENV_VARS.LOCAL_STORAGE_DIR] || LOCAL_ENV_VARS[ENV_VARS.LOCAL_STORAGE_DIR];

    if (!idOrName) idOrName = process.env[defaultIdEnvVar] || LOCAL_ENV_VARS[defaultIdEnvVar];

    let storagePromise = cache.get(idOrName);

    if (!storagePromise) {
        storagePromise = Promise.resolve(new LocalClass(idOrName, localStorageDir));
        cache.add(idOrName, storagePromise);
    }

    return storagePromise;
};

/**
 * Helper function to open remote storage.
 *
 * @ignore
 */
export const openRemoteStorage = async (idOrName, defaultIdEnvVar, RemoteClass, cache, getOrCreateFunction) => {
    let isDefault = false;

    if (!idOrName) {
        isDefault = true;
        idOrName = process.env[defaultIdEnvVar];
        if (!idOrName) throw new Error(`The '${defaultIdEnvVar}' environment variable is not defined.`);
    }

    let storagePromise = cache.get(idOrName);

    if (!storagePromise) {
        storagePromise = isDefault // If true then we know that this is an ID of existing store.
            ? Promise.resolve(new RemoteClass(idOrName))
            : getOrCreateFunction(idOrName).then(storage => (new RemoteClass(storage.id, storage.name)));
        cache.add(idOrName, storagePromise);
    }

    return storagePromise;
};

/**
 * Checks if at least one of APIFY_LOCAL_STORAGE_DIR and APIFY_TOKEN environment variables is set.
 * @ignore
 */
export const ensureTokenOrLocalStorageEnvExists = (storageName) => {
    if (!process.env[ENV_VARS.LOCAL_STORAGE_DIR] && !process.env[ENV_VARS.TOKEN]) {
        throw new Error(`Cannot use ${storageName} as neither ${ENV_VARS.LOCAL_STORAGE_DIR} nor ${ENV_VARS.TOKEN} environment variable is set. You need to set one these variables in order to enable data storage.`); // eslint-disable-line max-len
    }
};


// NOTE: We skipping 'noscript' since it's content is evaluated as text, instead of HTML elements. That damages the results.
const SKIP_TAGS_REGEX = /^(script|style|canvas|svg|noscript)$/i;
const BLOCK_TAGS_REGEX = /^(p|h1|h2|h3|h4|h5|h6|ol|ul|li|pre|address|blockquote|dl|div|fieldset|form|table|tr|select|option)$/i;


/**
 * The function converts a HTML document to a plain text.
 *
 * The plain text generated by the function is similar to a text captured
 * by pressing Ctrl+A and Ctrl+C on a page when loaded in a web browser.
 * The function doesn't aspire to preserve the formatting or to be perfectly correct with respect to HTML specifications.
 * However, it attempts to generate newlines and whitespaces in and around HTML elements
 * to avoid merging distinct parts of text and thus enable extraction of data from the text (e.g. phone numbers).
 *
 * **Example usage**
 * ```javascript
 * const text = htmlToText('<html><body>Some text</body></html>');
 * console.log(text);
 * ```
 *
 * Note that the function uses [cheerio](https://www.npmjs.com/package/cheerio) to parse the HTML.
 * Optionally, to avoid duplicate parsing of HTML and thus improve performance, you can pass
 * an existing Cheerio object to the function instead of the HTML text. The HTML should be parsed
 * with the `decodeEntities` option set to `true`. For example:
 *
 * ```javascript
 * const cheerio = require('cheerio');
 * const html = '<html><body>Some text</body></html>';
 * const text = htmlToText(cheerio.load(html, { decodeEntities: true }));
 * ```
 * @param {String|Function} html HTML text or parsed HTML represented using a
 * [cheerio](https://www.npmjs.com/package/cheerio) function.
 * @return {String} Plain text
 * @memberOf utils
 */
const htmlToText = (html) => {
    if (!html) return '';

    const $ = typeof html === 'function' ? html : cheerio.load(html, { decodeEntities: true });
    let text = '';

    const process = (elems) => {
        const len = elems ? elems.length : 0;
        for (let i = 0; i < len; i++) {
            const elem = elems[i];
            if (elem.type === 'text') {
                // Compress spaces, unless we're inside <pre> element
                let compr;
                if (elem.parent && elem.parent.tagName === 'pre') compr = elem.data;
                else compr = elem.data.replace(/\s+/g, ' ');
                // If text is empty or ends with a whitespace, don't add the leading whitepsace
                if (compr.startsWith(' ') && /(^|\s)$/.test(text)) compr = compr.substr(1);
                text += compr;
            } else if (elem.type === 'comment' || SKIP_TAGS_REGEX.test(elem.tagName)) {
                // Skip comments and special elements
            } else if (elem.tagName === 'br') {
                text += '\n';
            } else if (elem.tagName === 'td') {
                process(elem.children);
                text += '\t';
            } else {
                // Block elements must be surrounded by newlines (unless beginning of text)
                const isBlockTag = BLOCK_TAGS_REGEX.test(elem.tagName);
                if (isBlockTag && !/(^|\n)$/.test(text)) text += '\n';
                process(elem.children);
                if (isBlockTag && !text.endsWith('\n')) text += '\n';
            }
        }
    };

    // If HTML document has body, only convert that, otherwise convert the entire HTML
    const $body = $('body');
    process($body.length > 0 ? $body : $.root());

    return text.trim();
};


/**
 * A namespace that contains various utilities.
 *
 * **Example usage:**
 *
 * ```javascript
 * const Apify = require('apify');
 *
 * ...
 *
 * // Sleep 1.5 seconds
 * await Apify.utils.sleep(1500);
 * ```
 * @namespace utils
 */
export const publicUtils = {
    isDocker,
    sleep,
    downloadListOfUrls,
    extractUrls,
    getRandomUserAgent,
    htmlToText,
    URL_NO_COMMAS_REGEX,
    URL_WITH_COMMAS_REGEX,
};
