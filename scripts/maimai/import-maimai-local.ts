import { existsSync, readFileSync, readdirSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual, parseArgs } from 'node:util';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { validate } from 'jsonschema';
import { format } from 'prettier';
import type { Chart, GameData, Song } from '../../src/models/SongData';

const REPO = path.resolve(__dirname, '../..');
const DEFAULT_JSON = path.join(REPO, 'src/songs/maimai_dx_prism.json');
const DEFAULT_OUTPUT = path.join(REPO, 'src/songs/maimai_dx_prism_plus.json');
const DIFFICULTIES = ['basic', 'advanced', 'expert', 'master', 'remaster'];
const JACKET_FOLDER = 'maimai';

interface NameRef {
  id: string;
  str: string;
}
interface Notes {
  file: { path: string };
  level: string;
  levelDecimal: string;
  musicLevelID: string;
  isEnable: string;
  notesDesigner: NameRef;
}
interface MusicData {
  name: NameRef;
  artistName: NameRef;
  genreName: NameRef;
  AddVersion: NameRef;
  bpm: string;
  disable: string;
  utageKanjiName: string;
  notesData: { Notes: Notes[] };
}

const parser = new XMLParser({
  parseTagValue: false,
  trimValues: false,
  isArray: (name) => name === 'Notes',
});

function xml<T>(file: string, root: string): T {
  const text = readFileSync(file, 'utf8');
  const valid = XMLValidator.validate(text);
  if (valid !== true) throw new Error(`${file}: ${valid.err.msg}`);
  const data = parser.parse(text)[root];
  if (!data) throw new Error(`${file}: missing ${root}`);
  return data;
}

/** Accept the game root, Package, Sinmai_Data, StreamingAssets, or a data layer. */
export function dataLayers(input: string): string[] {
  const root = path.resolve(input);
  const streaming = [
    root,
    path.join(root, 'StreamingAssets'),
    path.join(root, 'Sinmai_Data/StreamingAssets'),
    path.join(root, 'Package/Sinmai_Data/StreamingAssets'),
  ].find((dir) => existsSync(path.join(dir, 'A000/music')));
  if (streaming) {
    return readdirSync(streaming, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(streaming, entry.name))
      .filter(
        (dir) =>
          existsSync(path.join(dir, 'DataConfig.xml')) ||
          existsSync(path.join(dir, 'music')),
      )
      .map((dir) => {
        const config = path.join(dir, 'DataConfig.xml');
        const version = existsSync(config)
          ? xml<{ version: { major: string; minor: string; release: string } }>(
              config,
              'DataConfig',
            ).version
          : { major: '0', minor: '0', release: '0' };
        const order = [version.major, version.minor, version.release].map(
          Number,
        );
        if (order.some((part) => !Number.isInteger(part) || part < 0))
          throw new Error(`Invalid data version: ${config}`);
        return { dir, order };
      })
      .sort(
        (a, b) =>
          a.order[0] - b.order[0] ||
          a.order[1] - b.order[1] ||
          a.order[2] - b.order[2] ||
          a.dir.localeCompare(b.dir, 'en', { numeric: true }),
      )
      .map(({ dir }) => dir);
  }
  if (existsSync(path.join(root, 'music'))) return [root];
  throw new Error(`No local maimai data found under ${root}`);
}

function tableFiles(layer: string, table: string, filename: string): string[] {
  const dir = path.join(layer, table);
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(dir, entry.name, filename))
    .filter(existsSync)
    .sort();
}

export function displayLevel(value: string): number {
  const match = /^(\d+)(\+)?$/.exec(value);
  if (!match) throw new Error(`Invalid game display level: ${value}`);
  return Number(match[1]) + (match[2] ? 0.5 : 0);
}

export function songFromXml(
  music: MusicData,
  levels: Map<string, number>,
  genres: Map<string, string>,
): Song | undefined {
  const id = Number(music.name.id);
  if (!Number.isInteger(id) || id < 0)
    throw new Error(`Invalid music ID: ${music.name.id}`);
  // Utage uses separate 100000+ IDs and chart slots, outside this catalog's STD/DX schema.
  if (id >= 100000 || music.utageKanjiName || music.disable === 'true') return;
  if (id === 0) return;
  if (id >= 20000) throw new Error(`Unsupported music ID: ${id}`);
  const category = genres.get(music.genreName.id) || music.genreName.str;
  if (!category) throw new Error(`Missing genre name for ${id}`);
  const flags = [id >= 10000 ? 'dx' : 'std'];
  const charts: Chart[] = [];
  music.notesData.Notes.forEach((notes, index) => {
    if (notes.isEnable !== 'true') return;
    const diffClass = DIFFICULTIES[index];
    if (!diffClass)
      throw new Error(`Unsupported enabled difficulty ${index} for ${id}`);
    const integer = Number(notes.level);
    const decimal = Number(notes.levelDecimal);
    const lvl = levels.get(notes.musicLevelID);
    if (
      !Number.isInteger(integer) ||
      integer < 1 ||
      !Number.isInteger(decimal) ||
      decimal < 0 ||
      decimal > 9 ||
      lvl === undefined ||
      Math.floor(lvl) !== integer
    )
      throw new Error(`Invalid level for music ${id}, ${diffClass}`);
    const chart: Chart = {
      diffClass,
      lvl,
      levelConstant: (integer * 10 + decimal) / 10,
      flags,
    };
    const author = notes.notesDesigner.str;
    if (author && author !== '-') chart.author = author;
    charts.push(chart);
  });
  if (!charts.length) return;
  return {
    id: String(id),
    name: music.name.str,
    artist: music.artistName.str,
    category,
    folder: music.AddVersion.str
      .replace(/^maimaDX/, 'maimaiでらっくす')
      .replace(/PLUS$/, ' PLUS'),
    bpm: music.bpm,
    jacket: `${JACKET_FOLDER}/${id}.png`,
    charts,
  };
}

/** Old catalogs encode the full chart-set ID in the jacket filename, including the DX offset. */
export function songId(song: Song): string | undefined {
  if (song.id && /^\d+$/.test(song.id)) return String(Number(song.id));
  const match = /^maimai\/(\d+)\.png$/.exec(song.jacket);
  return match ? String(Number(match[1])) : undefined;
}

function fallbackKey(song: Song): string {
  return JSON.stringify([
    song.name,
    song.artist,
    [...new Set(song.charts.flatMap((chart) => chart.flags ?? []))].sort(),
  ]);
}

export function mergeSongs(baseline: Song[], incoming: Song[]) {
  const byId = new Map<string, Song>();
  const byName = new Map<string, Song[]>();
  for (const song of incoming) {
    if (!song.id || byId.has(song.id))
      throw new Error(`Duplicate or missing local ID: ${song.id}`);
    byId.set(song.id, song);
    const key = fallbackKey(song);
    byName.set(key, [...(byName.get(key) ?? []), song]);
  }
  const used = new Set<string>();
  const retained: Song[] = [];
  const songs = baseline.map((old) => {
    const id = songId(old);
    const candidates =
      id === undefined ? byName.get(fallbackKey(old)) ?? [] : [];
    if (candidates.length > 1)
      throw new Error(`Ambiguous match for ${old.name}`);
    const local = id === undefined ? candidates[0] : byId.get(id);
    if (!local) {
      retained.push(old);
      return old;
    }
    if (used.has(local.id!))
      throw new Error(`Multiple baseline songs match ID ${local.id}`);
    used.add(local.id!);
    // Keep optional app-only metadata; all fields supplied by the game (including charts) win.
    return { ...old, ...local, jacket: old.jacket || local.jacket };
  });
  const added = incoming.filter((song) => !used.has(song.id!));
  songs.push(...added);
  return { songs, retained, added, matched: used.size };
}

export function extractCatalog(layers: string[]) {
  const levels = new Map<string, number>();
  const genres = new Map<string, string>();
  const records = new Map<string, MusicData>();
  const jackets = new Map<number, string>();
  for (const layer of layers) {
    for (const file of tableFiles(layer, 'musicGenre', 'MusicGenre.xml')) {
      const genre = xml<{ name: NameRef; genreName: string }>(
        file,
        'MusicGenreData',
      );
      genres.set(genre.name.id, genre.genreName || genre.name.str);
    }
    for (const file of tableFiles(layer, 'musicLevel', 'MusicLevel.xml')) {
      const level = xml<{ name: NameRef; levelNum: string }>(
        file,
        'MusicLevelData',
      );
      levels.set(level.name.id, displayLevel(level.levelNum));
    }
    for (const file of tableFiles(layer, 'music', 'Music.xml')) {
      const music = xml<MusicData>(file, 'MusicData');
      records.set(music.name.id, music);
    }
    const dir = path.join(layer, 'AssetBundleImages/jacket');
    if (existsSync(dir)) {
      for (const file of readdirSync(dir).sort()) {
        const match = /^ui_jacket_(\d+)\.ab$/i.exec(file);
        if (match) jackets.set(Number(match[1]), path.join(dir, file));
      }
    }
  }
  if (!records.size || !levels.size)
    throw new Error('Missing Music.xml or MusicLevel.xml tables');
  const songs: Song[] = [];
  const skipped: { id: string; name: string; reason: string }[] = [];
  for (const music of [...records.values()].sort(
    (a, b) => Number(a.name.id) - Number(b.name.id),
  )) {
    // 11879 (Xaleid◆scopiX (2)) is not a valid catalog song, despite its XML enabling it.
    if (music.name.id === '11879') {
      skipped.push({
        id: music.name.id,
        name: music.name.str,
        reason: 'excluded: invalid song',
      });
      continue;
    }
    const song = songFromXml(music, levels, genres);
    if (!song) {
      skipped.push({
        id: music.name.id,
        name: music.name.str,
        reason:
          Number(music.name.id) >= 100000 || music.utageKanjiName
            ? 'utage'
            : 'disabled/empty',
      });
      continue;
    }
    // Music.xml is authoritative for metadata even when a dump omits the .ma2 note files.
    songs.push(song);
  }
  if (!songs.length) throw new Error('No supported songs found');
  return { songs, jackets, skipped };
}

/** Reuse artwork before looking for bundles, including a song's STD/DX counterpart. */
export function planJackets(
  songs: Song[],
  bundles: Map<number, string>,
  jacketsDir: string,
) {
  const existingByBase = new Map<number, string>();
  const result = songs.map((song) => {
    const id = songId(song);
    const base = id === undefined ? undefined : Number(id) % 10000;
    const candidates = [
      song.jacket,
      ...(base === undefined
        ? []
        : [
            `${JACKET_FOLDER}/${id}.png`,
            `${JACKET_FOLDER}/${base}.png`,
            `${JACKET_FOLDER}/${base + 10000}.png`,
          ]),
    ];
    const existing = candidates.find(
      (file) => file && existsSync(path.join(jacketsDir, file)),
    );
    if (existing && base !== undefined) existingByBase.set(base, existing);
    return { ...song, jacket: existing ?? '' };
  });
  const missing: { base: number; jacket: string; bundle: string }[] = [];
  for (const [index, song] of result.entries()) {
    if (song.jacket) continue;
    // A legacy missing jacket still supplies its identity through the original song.
    const originalId = songId(songs[index]);
    if (originalId === undefined)
      throw new Error(`Cannot identify missing jacket for ${song.name}`);
    const base = Number(originalId) % 10000;
    const shared = existingByBase.get(base);
    if (shared) {
      song.jacket = shared;
      continue;
    }
    const bundle = bundles.get(base);
    if (!bundle)
      throw new Error(
        `No existing jacket or local bundle for ${originalId}: ${song.name}`,
      );
    song.jacket = `${JACKET_FOLDER}/${originalId}.png`;
    existingByBase.set(base, song.jacket);
    missing.push({ base, jacket: song.jacket, bundle });
  }
  return { songs: result, missing };
}

export function mergedCatalog(baseline: GameData, songs: Song[]): GameData {
  const newCategories = [...new Set(songs.map((song) => song.category))].filter(
    (category) => !baseline.meta.categories.includes(category),
  );
  const i18n = Object.fromEntries(
    Object.entries(baseline.i18n).map(([locale, dictionary]) => [
      locale,
      {
        ...Object.fromEntries(
          newCategories.map((category) => [category, category]),
        ),
        ...dictionary,
      },
    ]),
  );
  i18n.en = { ...i18n.en, name: 'maimai DX PRiSM PLUS' };
  return {
    ...baseline,
    meta: {
      ...baseline.meta,
      categories: [...baseline.meta.categories, ...newCategories],
    },
    defaults: {
      ...baseline.defaults,
      categories: [...baseline.defaults.categories, ...newCategories],
    },
    i18n,
    songs,
  };
}

async function writeIfChanged(
  file: string,
  bytes: Buffer | string,
): Promise<boolean> {
  const data = typeof bytes === 'string' ? Buffer.from(bytes) : bytes;
  if (existsSync(file) && (await readFile(file)).equals(data)) return false;
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  try {
    await writeFile(temporary, data);
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
  return true;
}

export async function importLocal(options: {
  gameData: string;
  input: string;
  output: string;
  jacketsDir: string;
  dryRun?: boolean;
}) {
  const baseline: GameData = JSON.parse(await readFile(options.input, 'utf8'));
  const schema = JSON.parse(
    await readFile(path.join(REPO, 'songs.schema.json'), 'utf8'),
  );
  validate(baseline, schema, { throwError: true });
  const layers = dataLayers(options.gameData);
  const local = extractCatalog(layers);
  const merge = mergeSongs(baseline.songs, local.songs);
  const images = planJackets(merge.songs, local.jackets, options.jacketsDir);
  const result = mergedCatalog(baseline, images.songs);
  validate(result, schema, { throwError: true });
  for (const song of result.songs) {
    if (!result.meta.categories.includes(song.category))
      throw new Error(`Unknown category: ${song.category}`);
    for (const chart of song.charts) {
      if (
        !result.meta.difficulties.some((d) => d.key === chart.diffClass) ||
        chart.lvl > result.meta.lvlMax ||
        chart.flags?.some((flag) => !result.meta.flags.includes(flag))
      ) {
        throw new Error(`Unsupported chart in ${song.name}`);
      }
    }
  }
  let imagesWritten = 0;
  if (!options.dryRun && images.missing.length) {
    const { loadAssetBundle, AssetType } = await import('@arkntools/unity-js');
    const staging = await mkdtemp(path.join(tmpdir(), 'maimai-jackets-'));
    try {
      // Decode everything before publishing any output, so corrupt bundles fail the import.
      for (const [index, image] of images.missing.entries()) {
        const file = image.bundle;
        const bundle = await loadAssetBundle(await readFile(file));
        const textures = bundle.objects.filter(
          (obj) => obj.type === AssetType.Texture2D,
        );
        const texture = textures[0];
        if (textures.length !== 1 || texture.type !== AssetType.Texture2D)
          throw new Error(
            `Expected one jacket texture in ${file}, found ${textures.length}`,
          );
        await writeFile(
          path.join(staging, `${image.base}.png`),
          await texture.getImage(),
        );
        if ((index + 1) % 200 === 0)
          console.log(
            `Decoded ${index + 1}/${images.missing.length} missing jackets`,
          );
      }
      for (const image of images.missing) {
        const destination = path.join(options.jacketsDir, image.jacket);
        await mkdir(path.dirname(destination), { recursive: true });
        try {
          await writeFile(
            destination,
            await readFile(path.join(staging, `${image.base}.png`)),
            { flag: 'wx' },
          );
          imagesWritten++;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
      }
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  }
  if (!options.dryRun) {
    const previous: GameData | undefined = existsSync(options.output)
      ? JSON.parse(await readFile(options.output, 'utf8'))
      : undefined;
    if (previous) result.meta.lastUpdated = previous.meta.lastUpdated;
    if (!isDeepStrictEqual(previous, result) || imagesWritten)
      result.meta.lastUpdated = Date.now();
    await writeIfChanged(
      options.output,
      await format(JSON.stringify(result), { parser: 'json' }),
    );
  }
  return {
    dryRun: !!options.dryRun,
    layers,
    baselineSongs: baseline.songs.length,
    localSongs: local.songs.length,
    matched: merge.matched,
    added: merge.added.map((song) => ({ id: song.id, name: song.name })),
    retained: merge.retained.map((song) => ({
      id: songId(song),
      name: song.name,
    })),
    skipped: local.skipped,
    totalSongs: result.songs.length,
    totalCharts: result.songs.reduce(
      (count, song) => count + song.charts.length,
      0,
    ),
    jackets: new Set(result.songs.map((song) => song.jacket)).size,
    jacketsToExtract: images.missing.length,
    imagesWritten,
  };
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      input: { type: 'string', default: DEFAULT_JSON },
      output: { type: 'string', default: DEFAULT_OUTPUT },
      'jackets-dir': {
        type: 'string',
        default: path.join(REPO, 'src/assets/jackets'),
      },
      'dry-run': { type: 'boolean', default: false },
      report: { type: 'string' },
      help: { type: 'boolean', default: false },
    },
  });
  if (values.help) {
    console.log(
      'Usage: yarn import:maimai-local <game-directory> [--input catalog.json] [--output catalog.json] [--jackets-dir directory] [--dry-run] [--report report.json]',
    );
    return;
  }
  if (positionals.length !== 1)
    throw new Error('Provide one local game directory. Use --help for usage.');
  const report = await importLocal({
    gameData: positionals[0],
    input: path.resolve(values.input!),
    output: path.resolve(values.output!),
    jacketsDir: path.resolve(values['jackets-dir']!),
    dryRun: values['dry-run'],
  });
  if (values.report)
    await writeIfChanged(
      path.resolve(values.report),
      JSON.stringify(report, null, 2) + '\n',
    );
  console.log(
    `${report.dryRun ? 'Dry run' : 'Imported'}: ${report.matched} matched, ${
      report.added.length
    } added, ${report.retained.length} retained, ${
      report.skipped.length
    } skipped; ${report.totalSongs} songs / ${report.totalCharts} charts; ${
      report.jackets
    } jackets (${report.jacketsToExtract} to extract, ${
      report.imagesWritten
    } written).`,
  );
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
}
