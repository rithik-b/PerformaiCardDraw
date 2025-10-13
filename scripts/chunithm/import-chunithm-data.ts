// Used for importing chunithm from opts
// Requires imagemagick

import fs, { readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { existsSync } from 'node:fs';
import { writeJsonData, execAsync } from '../utils';

const basePath = './.data/chunithm';

const xmlParser = new XMLParser();

const outputImagesDir = './src/assets/jackets/chunithm';
const OUTFILE = 'src/songs/chunithm_luminous_plus.json';

const versions = {
  100: 'CHUNITHM',
  105: 'CHUNITHM PLUS',
  110: 'AIR',
  115: 'AIR PLUS',
  120: 'STAR',
  125: 'STAR PLUS',
  130: 'AMAZON',
  135: 'AMAZON PLUS',
  140: 'CRYSTAL',
  145: 'CRYSTAL PLUS',
  150: 'PARADISE',
  155: 'PARADISE LOST',
  200: 'NEW',
  205: 'NEW PLUS',
  210: 'SUN',
  215: 'SUN PLUS',
  220: 'LUMINOUS',
  225: 'LUMINOUS PLUS',
  230: 'VERSE',
  235: 'X-VERSE',
};

const difficulties = [
  'basic',
  'advanced',
  'expert',
  'master',
  'ultima',
  'we',
] as const;

interface OutputChart {
  diffClass: (typeof difficulties)[number];
  lvl: number;
  levelConstant: number;
  flags: []; // Ignored for now
}

interface OutputSong {
  name: string;
  name_translation: string | undefined;
  artist: string;
  category: string;
  folder: string;
  jacket: string;
  defaultLocked: boolean;
  charts: OutputChart[];
}

const getVersionNumber = (releaseTag: string): number => {
  const match = releaseTag.match(/([1-2]{1}\.[0-9]{2})/);
  if (!match) return NaN;
  return parseInt(match[1].replace('.', ''), 10);
};

const translationUrl =
  'https://raw.githubusercontent.com/lomotos10/GCM-bot/refs/heads/main/data/aliases/en/chuni.tsv';

export default async function run() {
  const translationData = await fetch(translationUrl).then((res) =>
    res.text().then((t) => t.split('\n')),
  );
  const outputSongs: OutputSong[] = [];

  for (const opt of await readdir(basePath)) {
    if (!(await fs.stat(path.join(basePath, opt))).isDirectory()) continue;

    const inputDir = path.join(basePath, opt, 'music');
    if (!existsSync(inputDir)) continue;

    const folders = await readdir(inputDir);

    for (const folder of folders) {
      const fullPath = path.join(inputDir, folder);
      const stat = await fs.stat(fullPath);
      if (!stat.isDirectory()) continue;

      const xmlPath = path.join(fullPath, 'Music.xml');

      interface MusicData {
        MusicData: {
          dataName: string;
          releaseTagName: ArtistName;
          netOpenName: ArtistName;
          disableFlag: boolean;
          exType: number;
          name: ArtistName;
          sortName: string;
          artistName: ArtistName;
          genreNames: GenreNames;
          worksName: ArtistName;
          jaketFile: File;
          firstLock: boolean;
          enableUltima: boolean;
          isGiftMusic: boolean;
          releaseDate: number;
          priority: number;
          cueFileName: ArtistName;
          worldsEndTagName: ArtistName;
          starDifType: number;
          stageName: ArtistName;
          fumens: Fumens;
        };
      }

      interface ArtistName {
        id: number;
        str: string;
        data: string;
      }

      interface Fumens {
        MusicFumenData: MusicFumenDatum[];
      }

      interface MusicFumenDatum {
        type: ArtistName;
        enable: boolean;
        file: File;
        level: number;
        levelDecimal: number;
        notesDesigner: string;
        defaultBpm: number;
      }

      interface File {
        path: string;
      }

      interface GenreNames {
        list: List;
      }

      interface List {
        StringID: ArtistName;
      }

      const xmlData = xmlParser.parse(
        await fs.readFile(xmlPath, 'utf-8'),
      ) as MusicData;

      if (xmlData.MusicData.disableFlag) continue;

      const convertJacket = async (file: string) => {
        const inputFilePath = path.join(fullPath, file);
        const outputFilePath = path.join(
          outputImagesDir,
          `${xmlData.MusicData.name.id.toString()}.png`,
        );
        if (existsSync(outputFilePath)) return;
        await execAsync(`magick "${inputFilePath}" "${outputFilePath}"`);
      };

      await convertJacket(xmlData.MusicData.jaketFile.path);

      const charts: OutputChart[] = [];

      for (const inputChart of xmlData.MusicData.fumens.MusicFumenData) {
        if (!inputChart.enable) continue;

        const difficulty = difficulties[inputChart.type.id];
        if (inputChart.level === 0 || difficulty === 'we') continue;

        const levelConstant = inputChart.level + inputChart.levelDecimal / 100;
        const lvl =
          inputChart.level + (inputChart.levelDecimal >= 50 ? 0.5 : 0);
        charts.push({
          diffClass: difficulty,
          lvl,
          levelConstant,
          flags: [],
        });
      }

      const versionNumber = getVersionNumber(
        xmlData.MusicData.releaseTagName.str,
      );
      if (isNaN(versionNumber)) {
        throw new Error(
          `Unknown version for ${xmlData.MusicData.name.str} (${xmlData.MusicData.releaseTagName.str})`,
        );
      }

      if (charts.length === 0) continue;

      outputSongs.push({
        name: xmlData.MusicData.name.str.toString(),
        name_translation: translationData.find((n) =>
          n.includes(xmlData.MusicData.name.str),
        ),
        artist: xmlData.MusicData.artistName.str.toString(),
        category: xmlData.MusicData.genreNames.list.StringID.str,
        folder: versions[versionNumber as keyof typeof versions] ?? 'Unknown',
        jacket: `chunithm/${xmlData.MusicData.name.id.toString()}.png`,
        charts,
        defaultLocked: xmlData.MusicData.firstLock,
      });
    }
  }

  const filePath = path.join(__dirname, '../../', OUTFILE);
  const existingData = require(filePath);

  const data = {
    ...existingData,
    songs: outputSongs,
  };

  await writeJsonData(data, filePath);

  console.info('Done!');
}

if (require.main === module) run();
