import fs from 'fs';
import { promises } from 'fs';
import path from 'path';
import { format } from 'prettier';
import jimp from 'jimp';
import sanitize from 'sanitize-filename';
import pqueue from 'p-queue';
import { promisify } from 'node:util';
import { exec as baseExec } from 'node:child_process';

async function writeJsonData(data: any, filePath: string) {
  data.meta.lastUpdated = Date.now();
  let formatted;
  try {
    formatted = await format(JSON.stringify(data), { filepath: filePath });
  } catch (e) {
    throw new Error('Formatting failed ' + e);
  }
  return promises.writeFile(filePath, formatted);
}

const requestQueue = new pqueue({
  concurrency: 6, // 6 concurrent max
  interval: 1000,
  intervalCap: 10, // 10 per second max
});
const JACKETS_PATH = path.resolve(__dirname, '../src/assets/jackets');

let JACKET_PREFIX = '';
function setJacketPrefix(prefix: string) {
  JACKET_PREFIX = prefix;
}

/**
 * @param coverUrl {string} url of image to fetch
 * @param localFilename {string | undefined} override filename found in url
 *
 * queues a cover path for download into the imageQueue.
 * Always skips if file already exists.
 * Immediately returns the relative path to the jacket where it will be saved
 */
function downloadJacket(coverUrl: string, localFilename?: string) {
  if (!localFilename) {
    localFilename = JACKET_PREFIX + path.basename(coverUrl);
  } else {
    localFilename = JACKET_PREFIX + localFilename;
  }
  if (!localFilename.endsWith('.jpg')) {
    localFilename += '.jpg';
  }
  const sanitizedFilename = sanitize(path.basename(localFilename));
  const outputPath = path.join(path.dirname(localFilename), sanitizedFilename);
  const absoluteOutput = path.join(JACKETS_PATH, outputPath);
  if (!fs.existsSync(absoluteOutput)) {
    requestQueue
      .add(() => jimp.read(coverUrl))
      .then(
        (img) =>
          img?.resize(128, jimp.AUTO).quality(80).writeAsync(absoluteOutput),
      )
      .catch((e) => {
        console.error(`image download failure while requesting ${coverUrl}`);
        console.error(e);
      });
  }

  return outputPath;
}

const promisifiedExec = promisify(baseExec);
const execAsync = async (command: string) => {
  const { stderr, stdout } = await promisifiedExec(command);
  if (stderr) throw new Error(stderr);

  if (stdout) console.log(stdout);
};

export {
  writeJsonData,
  downloadJacket,
  requestQueue,
  setJacketPrefix,
  execAsync,
};
