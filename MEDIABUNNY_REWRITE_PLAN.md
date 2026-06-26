# Mediabunny 全面改修計画

作成日: 2026-06-26

## 目的

現行の `video_edit` を、`C:\work\script\RamPlayer_web` の Mediabunny / WebCodecs ベース実装を参考に全面改修する。

主な方針は次の通り。

- 動画ファイルをプロジェクト配下の `media/` にコピーしない。
- 読み込みはユーザーが選択した元ファイルを `FileSystemFileHandle` から再取得し、Mediabunny の `BlobSource(File)` に渡す。
- サムネイルを `cache/frames/...jpg` としてファイル保存しない。
- サムネイルは Mediabunny の `CanvasSink` / `EncodedPacketSink` で高速に生成し、`HTMLCanvasElement` をメモリ上の LRU キャッシュで管理する。
- 既存の素材棚、ソースタイムライン、出力シーケンス、クロップ編集は維持しつつ、動画 I/O とプレビュー処理を刷新する。

## 参照した情報

- `C:\work\script\RamPlayer_web`
  - `src/player/Player.ts`: Mediabunny `Input`, `BlobSource`, `CanvasSink`, `AudioBufferSink`, `EncodedPacketSink` による再生、シーク、サムネイル生成。
  - `src/main.ts`: タイムラインサムネイルのメモリ LRU、生成キュー、再生/シーク中の生成停止。
  - `src/persist/restore.ts`: `FileSystemFileHandle` を IndexedDB に保存し、権限確認後に `getFile()` で元ファイルを再取得。
  - `src/export/clipExport.ts`: Mediabunny `Conversion` と packet copy による MP4 書き出し。
- Mediabunny 公式リポジトリ: https://github.com/Vanilagy/mediabunny
  - ブラウザでの読み込み例は `new Input({ source: new BlobSource(file), formats: ALL_FORMATS })`。
  - `RamPlayer_web` は `mediabunny@^1.49.0` を使用している。
  - 読み書き、変換、WebCodecs ベースのデコード/エンコード、ストリーミング I/O が主要機能。

## 現状の課題

### 動画ファイル管理

現在の `js/fileOpen.js` は、プロジェクトを開いている場合に `projectStore.copyIntoMedia(file)` で動画を `media/` にコピーし、`relPath` を保存している。

問題:

- 大容量動画で初回追加が重い。
- 元ファイルとコピーの二重管理になる。
- `media/` 前提が `projectStore.findMedia()`、`.gitignore`、復元処理に広がっている。
- ファイルの実体がコピー側に移るため、ユーザーが期待する「元ファイルを編集素材として使う」挙動ではない。

### サムネイル

現在の `js/frameCache.js` は、メモリ LRU に加えて `cache/frames/<source>/<frame>.jpg` へ write-through している。

問題:

- プロジェクトフォルダに大量の jpg が発生する。
- ファイル I/O がタイムライン操作中の遅延要因になる。
- キャッシュ破棄やバージョン管理が複雑。
- `<video>` seek + `canvas.toBlob()` + object URL の流れが、Mediabunny の canvas 直接取得より遅くなりやすい。

### メディア処理

現在はプレビューに `<video>`、書き出しに `<video>` + `MediaRecorder` + ffmpeg.wasm fallback を使っている。

問題:

- 再生、サムネイル、書き出しで別々のデコード経路になっている。
- フレーム精度と GOP/キーフレーム扱いが分散している。
- 書き出し品質と対応形式が MediaRecorder/ブラウザ実装に強く依存する。

## 設計方針

### 1. ビルド基盤を Vite + TypeScript に寄せる

Mediabunny を npm dependency として使うため、現行の静的 ES modules 構成から Vite + TypeScript へ移行する。

予定:

- `package.json`, `tsconfig.json`, `vite.config.ts` を追加。
- 既存 `index.html`, `css/style.css`, `js/*.js` を段階的に `src/` へ移す。
- 初期段階では UI/状態管理の構造を大きく変えず、メディア層だけ TypeScript 化する。

理由:

- Mediabunny の型を使える。
- RamPlayer の実装を移植しやすい。
- バンドルと依存管理を明確にできる。

### 2. SourceMedia 層を新設する

`fileOpen.js` の責務を分割し、動画ソースごとに次の情報を管理する。

保存する情報:

- `id`
- `fileName`
- `size`
- `lastModified`
- `mediaKey`
- `duration`
- `fps`
- `width`
- `height`
- `hasAudio`
- `handleKey`

保存しない情報:

- `relPath`
- `media/` 内コピー先
- サムネイルキャッシュファイルパス

ランタイム管理:

- `sourceId -> FileSystemFileHandle | null`
- `sourceId -> File | null`
- `sourceId -> Mediabunny Input session`
- `sourceId -> object URL` は当面 `<video>` 互換が残る箇所のみ一時的に利用し、最終的には削る。

ブラウザでは任意の絶対パス文字列から直接読むことはできないため、「元パスから読む」は `FileSystemFileHandle` を保存し、必要時にユーザー権限を確認して `handle.getFile()` で元ファイルを再取得する形にする。ドラッグ&ドロップ時は `DataTransferItem.getAsFileSystemHandle()` が使える場合だけ handle を保持し、通常の file input ではセッション中の `File` のみ保持する。

### 3. プロジェクト保存形式を更新する

`project.version` を上げ、動画ソースの保存形式をコピー前提から handle 前提に移行する。

移行ルール:

- 既存 `relPath: media/...` があるプロジェクトは読み込み可能にする。
- 既存の `media/` コピーが見つかる場合は、移行時だけそのファイルを再リンク候補として扱う。
- 新規追加では `media/` へコピーしない。
- `.gitignore` から `media/` と `cache/` 前提を削除、または後方互換用コメントに留める。

IndexedDB:

- 既存 `handles` store を使うか、`sourceHandles` store を追加する。
- `media:<sourceId>` ではなく `source:<sourceId>:handle` のような用途が分かる key にする。
- handle がない場合は、起動後に「再リンクが必要」状態として UI に出す。

### 4. MediabunnySourceSession を導入する

ソースごとに Mediabunny の読み込み状態をまとめるクラスを作る。

責務:

- `File` から `Input({ source: new BlobSource(file), formats: ALL_FORMATS })` を作る。
- `canRead()`、primary video/audio track 取得。
- duration, fps, width, height, rotation, audio 有無を解析。
- `CanvasSink` を用途別に持つ。
- `EncodedPacketSink` をキーフレームサムネイル/packet copy 用に持つ。
- `dispose()` で Input と進行中 iterator を確実に解放する。

想定 sink:

- プレビュー/正確シーク用 `CanvasSink(videoTrack, { poolSize: 2, fit: 'contain' })`
- サムネイル用 `CanvasSink(videoTrack, { poolSize: 1, width, height, fit: 'cover' })`
- キーフレーム探索用 `EncodedPacketSink(videoTrack)`
- 音声が必要な箇所は `AudioBufferSink(audioTrack)`

### 5. サムネイル生成をメモリオンリーにする

`js/frameCache.js` と `js/thumbnails.js` を置き換える。

新設候補:

- `src/media/thumbnailCache.ts`
- `src/media/thumbnailScheduler.ts`
- `src/timeline/sourceTimeline.ts`

基本仕様:

- キャッシュ値は object URL ではなく `HTMLCanvasElement`。
- key は `sourceId + visibleSlotStart + visibleSlotEnd + exact/keyframe + dpr + thumbSize`。
- LRU 上限は件数と推定メモリ量の両方で制御する。
- 生成済み canvas をタイムライン canvas へ直接 `drawImage()` する。
- `<img src=objectURL>` のセル DOM 群は廃止し、タイムライン全体を canvas 描画へ寄せる。

RamPlayer から取り込む挙動:

- 表示範囲に応じてサムネイル slot 数を制御する。
- まず keyframe thumbnail を出して即時表示、余裕があるとき exact thumbnail で置き換える。
- 再生中、シーク中、ドラッグ中はサムネイル生成を止める。
- hover preview は近い既存サムネイルを先に表示し、後から exact を取得する。
- サムネイル生成 queue は generation id でキャンセル可能にする。

### 6. ソースタイムラインを canvas ベースへ寄せる

現在の `sourceTimeline.js` は DOM の `thumbRow` と clip band を組み合わせている。サムネイル刷新に合わせ、少なくともサムネイル行は canvas 描画に変える。

段階案:

1. 既存 DOM タイムラインを維持し、`thumb-cell img` の代わりに canvas から `toDataURL` せず直接描画する overlay canvas を追加。
2. 動作が安定したら clip band、overview、playhead も canvas へ統合する。
3. フレーム単位ズーム時の境界合わせは現在の `FRAME_CELL_MIN_PX` 相当のロジックを canvas 上で再実装する。

### 7. プレビュー再生を段階的に Mediabunny 化する

全面移行の最終形は、`<video id="srcVideo">` 依存を減らし、Mediabunny + canvas player に寄せる。

ただし、編集アプリ側はクロッププレビュー、素材選択、出力シーケンス再生など既存連携が多いので段階的に行う。

Phase A:

- `<video>` 再生は残す。
- メタデータ取得とサムネイルだけ Mediabunny に移行。
- `urlFor()` は一時互換として残す。

Phase B:

- RamPlayer の `Player` を複数ソース対応に分解して導入。
- ソースプレビューを canvas 再生へ置き換える。
- `requestVideoFrameCallback` 依存の fps probe を Mediabunny track stats へ置き換える。

Phase C:

- クロッププレビューも canvas source frame を入力にする。
- 出力シーケンス再生を複数 source session の切り替えで実装する。
- `<video>` は fallback または削除。

### 8. 書き出しを Mediabunny 中心へ再設計する

現在の `export.js` は `<video>` + `MediaRecorder` が中心。Mediabunny へ寄せる場合は 2 系統を用意する。

短期:

- 既存 export は `freshFileFor()` の移行に合わせて、元 handle から取得した `File` を使うようにする。
- `media/` コピー前提をなくす。

中期:

- RamPlayer の `export/clipExport.ts` をベースに、単一素材の MP4 trim/export を Mediabunny `Conversion` で実装する。
- GOP が合う場合は packet copy、合わない場合は reencode を選ぶ。

長期:

- 複数素材 + クロップ + テキスト overlay + 9:16 出力を Mediabunny `Output` + `CanvasSource` + audio mixing で作る。
- ffmpeg.wasm fallback は縮小または廃止する。

注意:

- 現行のクロップ/overlay 合成は canvas で必要。
- 音声の複数クリップ連結と BGM 対応は別途設計が必要。
- packet copy はクロップ/テキスト合成とは両立しないため、無変換 trim 用の最適化として扱う。

## 実装フェーズ

### Phase 0: 土台整理

- Vite + TypeScript の最小構成を追加する。
- Mediabunny `^1.49.0` を dependency に追加する。
- 既存アプリが起動する状態を維持する。
- 文字化けコメント/文言は機能変更と分けて扱う。

完了条件:

- `npm run dev` で現行 UI が開く。
- `npm run build` が通る。

### Phase 1: コピー廃止

- `projectStore.copyIntoMedia()` を新規追加フローから外す。
- `fileOpen` を `mediaRegistry` / `sourceHandles` に分割する。
- 新規追加時は元 handle と `File` を登録する。
- プロジェクト保存には `relPath` を書かない。
- 既存プロジェクトの `relPath` は読み込み互換だけ残す。

完了条件:

- 新規追加で `media/` に動画がコピーされない。
- 再読み込み後、権限が残っていれば元ファイルを自動再リンクできる。
- 権限がなければ明示的な再リンク UI になる。

### Phase 2: Mediabunny メタデータ解析

- `probeDuration()` と `probeFps()` を Mediabunny ベースに置き換える。
- `duration`, `fps`, `width`, `height`, `hasAudio` を source model に保存する。
- デコード不可 codec のエラーを UI に返す。

完了条件:

- MP4/MOV/WebM/MKV でメタデータが取得できる。
- fps が `requestVideoFrameCallback` の再生サンプリングなしで決まる。

### Phase 3: メモリサムネイル

- `frameCache.js` のファイル write-through を廃止する。
- `CanvasSink` で keyframe/exact thumbnail を生成する。
- タイムライン表示範囲ごとの thumbnail queue を実装する。
- メモリ LRU と generation cancel を実装する。

完了条件:

- `cache/frames` が作られない。
- タイムラインスクロール/ズーム中にサムネイル生成が詰まらない。
- 再生・シーク操作がサムネイル生成より優先される。

### Phase 4: プレビューの Mediabunny 化

- RamPlayer の `Player` を編集アプリ用に分解する。
- source preview を canvas 再生へ置き換える。
- フレーム送り、範囲再生、ループ、シーケンス再生を canvas player で実装する。

完了条件:

- `<video>` なしでソースプレビュー、素材範囲再生、出力シーケンス再生ができる。
- 大きな動画でもメモリ上限内でシーク/停止/再生できる。

### Phase 5: 書き出し刷新

- 元 handle から取得した `File` を export に渡す。
- 単一クリップ trim は Mediabunny の packet copy / reencode を導入する。
- 複数素材 + クロップ出力は `Output` + canvas 合成で再実装する。
- ffmpeg.wasm は必要な fallback のみに残す。

完了条件:

- コピーなしの元ファイルから書き出せる。
- 既存の 9:16 crop 出力と見た目が一致する。
- 長尺/大容量でも wasm メモリに全投入しない。

## データ移行方針

新しい source 例:

```json
{
  "id": "src_xxxxxxx",
  "fileName": "input.mp4",
  "mediaKey": "hash(name:size:lastModified)",
  "size": 123456789,
  "lastModified": 1780000000000,
  "duration": 123.456,
  "fps": 29.97,
  "width": 1920,
  "height": 1080,
  "hasAudio": true,
  "handleKey": "source:src_xxxxxxx:handle"
}
```

旧 source:

```json
{
  "id": "src_xxxxxxx",
  "fileName": "input.mp4",
  "relPath": "media/input.mp4",
  "duration": 123.456,
  "fps": 30
}
```

移行時:

- `relPath` は保持してもよいが、新規保存時には書かない。
- `handleKey` がない source は `missing` として扱う。
- 旧 `media/` 内にファイルが存在する場合だけ、自動再リンク候補にする。

## リスクと対策

- ブラウザは絶対パス文字列から直接ファイルを開けない。
  - 対策: File System Access API の handle を保存し、権限がない場合は再リンクを要求する。
- Safari/Firefox は File System Access API と WebCodecs 対応が限定的。
  - 対策: Chrome/Edge を主対象に明記し、file input fallback はセッション限定にする。
- `CanvasSink` の多重生成でメモリを使いすぎる。
  - 対策: 用途ごとの poolSize を小さくし、LRU を件数/推定 bytes で制御する。
- タイムライン exact thumbnail が重い。
  - 対策: keyframe を先に表示し、アイドル時だけ exact に差し替える。
- 既存 `<video>` 前提の UI が多い。
  - 対策: Phase A では `<video>` を残し、Mediabunny 化をサムネイル/メタデータから始める。
- 書き出しはクロップ/テキスト/音声で複雑。
  - 対策: 元ファイル読み込み対応を先に行い、書き出しエンジン刷新は独立フェーズにする。

## 検証項目

- 新規プロジェクトで動画追加後、`media/` にコピーされない。
- プロジェクト保存後にブラウザを再読み込みし、権限があれば元ファイルを復元できる。
- 権限がない場合に再リンク導線が出る。
- `cache/frames` が作成されない。
- タイムラインのズーム/パン/素材選択でサムネイルが破綻しない。
- 再生中にサムネイル生成が UI を固めない。
- 素材範囲、出力シーケンス、クロッププレビューの表示が現行と一致する。
- 4K/長尺/可変 fps/音声なし/回転 metadata 付き動画で挙動を確認する。
- build が通る。

## 最初に着手する変更

1. `package.json` / Vite / TypeScript を導入する。
2. `src/media/sourceRegistry.ts` を作り、元 handle から `File` を再取得する経路を実装する。
3. `copyIntoMedia()` 呼び出しを外し、新規追加で `media/` にコピーしないようにする。
4. Mediabunny でメタデータ取得だけを先に置き換える。
5. `frameCache.js` のファイル保存を止め、メモリ LRU のみにする。
6. `CanvasSink` ベースのサムネイル生成を導入し、既存タイムラインに接続する。
