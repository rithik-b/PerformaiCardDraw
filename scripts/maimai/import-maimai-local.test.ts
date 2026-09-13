import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { GameData, Song } from '../../src/models/SongData';
import {
  dataLayers,
  displayLevel,
  extractCatalog,
  importLocal,
  mergedCatalog,
  mergeSongs,
  planJackets,
} from './import-maimai-local';

const song = (id: number, name = 'Same title'): Song => ({
  name,
  artist: 'Artist',
  category: 'Old category',
  folder: 'PRiSM',
  jacket: `maimai/${id}.png`,
  charts: [
    {
      diffClass: 'master',
      lvl: 12,
      levelConstant: 12.5,
      flags: [id >= 10000 ? 'dx' : 'std'],
    },
  ],
});

test('local IDs win even after a rename; STD, DX and unrelated same-title songs stay distinct', () => {
  const old = [song(8), song(10008), song(9), song(10, 'Removed from game')];
  old[0].charts.push({ diffClass: 'remaster', lvl: 13, flags: ['std'] });
  const updated = {
    ...song(8, 'Renamed locally'),
    id: '8',
    artist: 'New artist',
  };
  const added = { ...song(11, 'New song'), id: '11' };
  const local = [
    updated,
    { ...song(10008), id: '10008' },
    { ...song(9), id: '9' },
    added,
  ];
  const result = mergeSongs(old, local);
  assert.equal(result.matched, 3);
  assert.deepEqual(result.retained, [old[3]]);
  assert.deepEqual(result.added, [added]);
  assert.deepEqual(result.songs[0], updated);
  assert.equal(result.songs.length, 5);
  assert.deepEqual(mergeSongs(result.songs, local).songs, result.songs);
  assert.throws(
    () => mergeSongs([old[0], old[0]], local),
    /Multiple baseline songs/,
  );
});

test('ambiguous ID-less matches fail instead of silently merging unrelated songs', () => {
  const old = { ...song(8), jacket: 'custom.png' };
  assert.throws(
    () =>
      mergeSongs(
        [old],
        [
          { ...song(8), id: '8' },
          { ...song(9), id: '9' },
        ],
      ),
    /Ambiguous/,
  );
});

test('arbitrary categories are registered in metadata, defaults and locale fallbacks without losing prior selections', () => {
  const baseline: GameData = JSON.parse(
    readFileSync(
      path.resolve(__dirname, '../../src/songs/maimai_dx_prism.json'),
      'utf8',
    ),
  );
  baseline.meta.categories = ['Old category', 'Excluded category'];
  baseline.defaults.categories = ['Old category'];
  baseline.i18n.en['Old category'] = 'Existing translation';
  const incoming = [
    { ...song(8), category: 'A future ＆ custom genre' },
    song(9),
  ];
  const result = mergedCatalog(baseline, incoming);
  assert.deepEqual(result.meta.categories, [
    'Old category',
    'Excluded category',
    'A future ＆ custom genre',
  ]);
  assert.deepEqual(result.defaults.categories, [
    'Old category',
    'A future ＆ custom genre',
  ]);
  assert.equal(result.i18n.en['Old category'], 'Existing translation');
  assert.equal(
    result.i18n.en['A future ＆ custom genre'],
    'A future ＆ custom genre',
  );
  assert.deepEqual(mergedCatalog(result, incoming), result);
  assert.deepEqual(baseline.defaults.categories, ['Old category']);
});

test('local XML tables resolve arbitrary genre IDs, overlays and displayed plus levels; dry-run is read-only', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'maimai-import-test-'));
  const write = (file: string, text: string) => {
    const target = path.join(root, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, text);
  };
  const musicXml = (
    name: string,
    genreId = '999',
    lockType = '0',
  ) => `<MusicData>
    <name><id>10008</id><str>${name}</str></name>
    <artistName><id>1</id><str>Local artist</str></artistName>
    <genreName><id>${genreId}</id><str>Unlisted future genre</str></genreName>
    <AddVersion><id>24</id><str>PRiSMPLUS</str></AddVersion>
    <bpm>180</bpm><lockType>${lockType}</lockType><subLockType>1</subLockType><disable>false</disable><utageKanjiName />
    <notesData><Notes><file><path>not-needed.ma2</path></file><level>12</level><levelDecimal>6</levelDecimal>
    <musicLevelID>18</musicLevelID><isEnable>true</isEnable><notesDesigner><id>1</id><str>Designer</str></notesDesigner></Notes>
    <Notes><isEnable>false</isEnable></Notes></notesData></MusicData>`;
  try {
    write(
      'A000/musicLevel/18/MusicLevel.xml',
      '<MusicLevelData><name><id>18</id></name><levelNum>12+</levelNum></MusicLevelData>',
    );
    write(
      'A000/musicGenre/999/MusicGenre.xml',
      '<MusicGenreData><name><id>999</id><str>Internal name</str></name><genreName>Brand new ＆ genre</genreName></MusicGenreData>',
    );
    write('A000/music/10008/Music.xml', musicXml('Old name'));
    write(
      'A000/AssetBundleImages/jacket/ui_jacket_000008.ab',
      'dry-run never decodes this fixture',
    );
    write('A001/music/10008/Music.xml', musicXml('Updated name'));
    const layers = dataLayers(root);
    assert.deepEqual(layers, [
      path.join(root, 'A000'),
      path.join(root, 'A001'),
    ]);
    let local = extractCatalog(layers);
    assert.equal(local.songs.length, 1);
    assert.equal(local.songs[0].name, 'Updated name');
    assert.equal(local.songs[0].category, 'Brand new ＆ genre');
    assert.equal(local.songs[0].charts[0].lvl, 12.5);
    assert.equal(local.songs[0].charts[0].levelConstant, 12.6);
    assert.equal(local.songs[0].charts[0].author, 'Designer');
    assert.deepEqual(local.songs[0].charts[0].flags, ['dx']);
    assert.equal(local.songs[0].charts.length, 1);
    assert.equal(
      local.songs[0].defaultLocked,
      false,
      'extra-chart locks do not lock the whole song',
    );
    for (const lockType of ['1', '2', '3', '4']) {
      write(
        'A001/music/10008/Music.xml',
        musicXml('Updated name', '999', lockType),
      );
      const lockedSong = extractCatalog(layers).songs[0];
      assert.equal(lockedSong.defaultLocked, true);
      assert.equal(
        mergeSongs([{ ...song(10008), defaultLocked: false }], [lockedSong])
          .songs[0].defaultLocked,
        true,
      );
    }
    write('A001/music/10008/Music.xml', musicXml('Updated name'));
    assert.equal(
      mergeSongs(
        [{ ...song(10008), defaultLocked: true }],
        extractCatalog(layers).songs,
      ).songs[0].defaultLocked,
      false,
      'later unlocks clear stale lock indicators',
    );
    write(
      'A001/musicGenre/999/MusicGenre.xml',
      '<MusicGenreData><name><id>999</id><str>Internal name</str></name><genreName>Renamed genre</genreName></MusicGenreData>',
    );
    assert.equal(extractCatalog(layers).songs[0].category, 'Renamed genre');
    write('A001/music/10008/Music.xml', musicXml('Updated name', '123456'));
    local = extractCatalog(layers);
    assert.equal(local.songs[0].category, 'Unlisted future genre');
    const baseline: GameData = JSON.parse(
      readFileSync(
        path.resolve(__dirname, '../../src/songs/maimai_dx_prism.json'),
        'utf8',
      ),
    );
    baseline.songs = [song(10008)];
    write('baseline.json', JSON.stringify(baseline));
    write('output.json', 'Do not change');
    const report = await importLocal({
      gameData: root,
      input: path.join(root, 'baseline.json'),
      output: path.join(root, 'output.json'),
      jacketsDir: path.join(root, 'jackets'),
      dryRun: true,
    });
    assert.equal(report.matched, 1);
    assert.equal(report.imagesWritten, 0);
    assert.equal(
      readFileSync(path.join(root, 'output.json'), 'utf8'),
      'Do not change',
    );
    assert.deepEqual(
      JSON.parse(readFileSync(path.join(root, 'baseline.json'), 'utf8')),
      baseline,
    );
    // A real import must reuse an existing jacket without touching the deliberately
    // invalid bundle, and be byte-stable even when input and output are separate.
    write('jackets/maimai/10008.png', 'existing jacket stays untouched');
    rmSync(path.join(root, 'output.json'));
    const options = {
      gameData: root,
      input: path.join(root, 'baseline.json'),
      output: path.join(root, 'output.json'),
      jacketsDir: path.join(root, 'jackets'),
    };
    assert.equal((await importLocal(options)).imagesWritten, 0);
    const firstOutput = readFileSync(options.output);
    assert.equal((await importLocal(options)).imagesWritten, 0);
    assert.deepEqual(readFileSync(options.output), firstOutput);
    assert.deepEqual(JSON.parse(readFileSync(options.input, 'utf8')), baseline);
    assert.equal(
      readFileSync(path.join(root, 'jackets/maimai/10008.png'), 'utf8'),
      'existing jacket stays untouched',
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('display levels use the local table, including 15 and 15+', () => {
  assert.equal(displayLevel('15'), 15);
  assert.equal(displayLevel('15+'), 15.5);
  assert.throws(() => displayLevel('unknown'), /Invalid game display level/);
});

test('data layers include K updates and follow DataConfig versions rather than folder prefixes', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'maimai-layers-test-'));
  try {
    for (const [name, release] of [
      ['A000', 0],
      ['K061', 9],
      ['K001', 1],
      ['A001', 10],
    ] as const) {
      const dir = path.join(root, name);
      mkdirSync(path.join(dir, 'music'), { recursive: true });
      writeFileSync(
        path.join(dir, 'DataConfig.xml'),
        `<DataConfig><version><major>1</major><minor>55</minor><release>${release}</release></version></DataConfig>`,
      );
    }
    mkdirSync(path.join(root, 'Table'));
    assert.deepEqual(
      dataLayers(root).map((dir) => path.basename(dir)),
      ['A000', 'K001', 'K061', 'A001'],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('existing jackets are reused without bundles; missing STD/DX artwork is extracted only once', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'maimai-jackets-test-'));
  try {
    mkdirSync(path.join(root, 'maimai'));
    writeFileSync(path.join(root, 'maimai/8.png'), 'existing artwork');
    writeFileSync(path.join(root, 'maimai/10009.png'), 'existing DX artwork');
    const songs = [
      song(8),
      song(10008),
      song(9),
      { ...song(10010), id: '10010' },
      { ...song(10), id: '10' },
    ];
    const planned = planJackets(
      songs,
      new Map([[10, '/local/jacket.ab']]),
      root,
    );
    assert.deepEqual(
      planned.songs.map((s) => s.jacket),
      [
        'maimai/8.png',
        'maimai/8.png',
        'maimai/10009.png',
        'maimai/10010.png',
        'maimai/10010.png',
      ],
    );
    assert.equal(planned.missing.length, 1);
    assert.equal(
      readFileSync(path.join(root, 'maimai/8.png'), 'utf8'),
      'existing artwork',
    );
    assert.throws(
      () => planJackets([song(99)], new Map(), root),
      /No existing jacket or local bundle/,
    );
    assert.equal(planJackets([song(8)], new Map(), root).missing.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
