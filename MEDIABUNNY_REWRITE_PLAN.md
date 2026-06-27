# Mediabunny 全面改修計画

作成日: 2026-06-26  
更新日: 2026-06-27

## 目的

`C:\work\script\RamPlayer_web` の実装を参考に、`video_edit` を Mediabunny / WebCodecs ベースへ寄せる。方針は次の通り。

- 動画ファイルはプロジェクト配下へコピーしない。元ファイルの `FileSystemFileHandle` から読み直す。
- サムネイルはファイルとして保存しない。Mediabunny `CanvasSink` で必要時にメモリ上へ作成する。
- 書き出しは `<video>` 再生、`canvas.captureStream()`、`MediaRecorder` に依存しない。Mediabunny `Output` / `CanvasSource` / `AudioSampleSource` で確定フレームを書き出す。
- プレビューも可能な範囲から Mediabunny の exact frame 描画へ移す。特に出力クリップ連続再生は書き出しと同じ `[in, out)` 境界で扱う。
- 旧プロジェクト互換は不要。現在のデータ形式を優先して単純化する。

## 現状棚卸し

| 領域 | 現状 | 判定 |
| --- | --- | --- |
| 作業フォルダ | 起動時に作業フォルダを選び、`.viralcut/project.json` と `.viralcut/history.json` を保存する。 | 完了 |
| 元動画アクセス | `FileSystemFileHandle` を IndexedDB に保存し、プロジェクト JSON には `handleKey` / 権限情報を残す。 | 完了 |
| 動画コピー廃止 | 新規追加で `media/` へコピーしない。元ファイルを読む。 | 完了 |
| メタデータ | `mediaInfo.js` が Mediabunny `Input` / track stats を使う。 | 完了、ただし native fallback が残る |
| Mediabunny session 共通化 | `mediaSession.js` を追加し、プレビューとサムネイルの exact frame 取得を共通化した。 | 一部完了 |
| タイムラインサムネイル | `thumbnails.js` が `mediaSession.js` 経由の `CanvasSink` でメモリ生成する。ファイルキャッシュなし。 | 完了 |
| 下段毎フレームライン | `frameStrip.js` で現在フレーム前後の exact frame と素材枠を表示し、編集できる。 | 完了 |
| 書き出し映像 | `export.js` が Mediabunny `Output` + `CanvasSource` でフレーム単位に encode する。 | 完了 |
| 書き出し音声 | `AudioSampleSink` / `AudioSampleSource` で素材音声を範囲トリムして連結する。 | 完了 |
| 書き出し設定 | ファイル名保持、FPS 選択、単一ソース FPS 継承、長辺 1080 上限の解像度決定。 | 完了 |
| 通常プレビュー | `<video id="srcVideo">` の `currentTime` / `play()` に依存する。 | 未完 |
| 出力連続プレビュー | 通常の連続再生は音声とリアルタイム性を優先して native video 経路を使う。Mediabunny exact frame preview は検証用候補として残す。 | 一部完了 |
| クロッププレビュー | `<video>` と外部 canvas frame の両方を同じ crop 計算で描画できる。通常ソース再生はまだ `<video>`。 | 一部完了 |
| 上段タイムライン操作 | seek / playhead は `<video>.currentTime` に依存する。 | 未完 |
| native fallback | `fileOpen.js` に `<video>` metadata / fps fallback が残る。 | 要整理 |
| Object URL | プレビュー `<video>` 用に `URL.createObjectURL()` が残る。 | `<video>` 廃止まで必要 |

## 重要な問題

### 出力連続プレビューの 1 フレーム混入

書き出し結果には混入がないため、原因は export ではなくプレビュー側。現在の連続再生は `<video>` の実時間再生を rAF で監視し、`currentTime >= out - guard` になったら次素材へ切り替える方式。ブラウザのデコード・描画タイミング次第で `out` 以降のフレームが一瞬表示される。

対策:

- 出力シーケンス再生は `<video>.play()` ではなく Mediabunny `CanvasSink.getCanvas()` の exact frame で描画する。
- フレーム範囲は書き出しと同じ `[inFrame, outFrame)` に揃える。
- クロップ描画は export と同じ crop 計算を使う。
- `<video>` は当面、元プレビューと上段タイムライン操作用に残すが、出力連続プレビューでは再生させない。

## 全体設計

### 1. Mediabunny Source Session を共通化する

現在は `thumbnails.js` と `export.js` がそれぞれ `Input` / `CanvasSink` を作っている。次の共通層を追加して、フレーム取得を一箇所へ寄せる。

- `js/mediaSession.js`
  - `File` から `Input({ source: new BlobSource(file), formats: ALL_FORMATS })` を作る。
  - `sourceId + file identity + sink option` 単位で `CanvasSink` を保持する。
  - `getVideoFrameCanvas(source, frame, fps, options)` で exact frame を返す。
  - `disposeMediaSessions()` でまとめて解放できる。

### 2. プレビューを段階的に Mediabunny 化する

優先順:

1. 出力シーケンス連続再生を Mediabunny exact frame 描画へ変更する。
2. 9:16 クロッププレビューを `<video>` と外部 canvas の両方から描けるようにする。
3. ソースの一時停止中 seek を Mediabunny frame 描画へ寄せる。
4. 通常再生も canvas player に置き換え、最後に `<video id="srcVideo">` と object URL を削る。

音声プレビューは映像のフレーム境界問題とは分離する。まず映像を確定させ、次に WebAudio + Mediabunny audio samples で追従させる。

### 3. 書き出しは現在の方針を維持する

現在の `export.js` は Mediabunny/WebCodecs ベースでよい。

- 入力: 元ファイル handle から `freshFileFor()` で再取得。
- 映像: `CanvasSink` で素材フレーム取得、合成 canvas を `CanvasSource` へ投入。
- 音声: `AudioSampleSink.samples(in, out)` を trim し、`AudioSampleSource` へ timestamp を詰めて投入。
- 境界: 素材は `[inFrame, outFrame)` として扱い、`outFrame - 1` が最後の表示フレーム。

改善候補:

- `export.js` も `mediaSession.js` を使い、session 管理と dispose を共通化する。
- 無加工単一 trim だけは将来 packet copy 最適化を検討する。ただし crop / 複数素材 / overlay がある通常経路では reencode が正しい。

### 4. native fallback を整理する

`fileOpen.js` の `<video>` metadata fallback は、Mediabunny 移行が安定したら削除する。削除後は decode 不可ファイルを明示エラーにし、ユーザーへ再エンコードや別形式を促す。

当面は fallback を残しても export / thumbnail / frame strip の主経路は Mediabunny のまま。ただし「Mediabunny で読めないが `<video>` では読める」ファイルは export できない可能性があるため、UI に decode 可否を出すのが望ましい。

## 実装フェーズ

### Phase 1: 現状維持のまま安全化

- [x] 計画ファイルを現状に合わせて更新する。
- [x] 出力連続プレビューの検証用 Mediabunny exact frame 描画を追加する。
- [x] 通常の出力連続再生は音声とリアルタイム性のため native video 経路へ戻す。
- [x] 既存の通常プレビュー、上段タイムライン、下段 frame strip は壊さない。

完了条件:

- 出力クリップ連続再生で `out` 以降の不要フレームが表示されない。
- 書き出し結果とプレビューの素材境界が一致する。
- `node --check` が通る。

### Phase 2: Source Session 共通化

- [x] `mediaSession.js` を追加する。
- [x] preview / thumbnail の exact frame 取得を共有する。
- [ ] export の映像 session も共有層へ寄せる。
- [ ] session の LRU と dispose を入れる。
- [ ] 連続フレーム取得時の queue / generation cancel を統一する。

完了条件:

- 同じ動画に対する `Input` / `CanvasSink` の重複生成が減る。
- seek / timeline 操作で古い frame request が描画を上書きしない。

### Phase 3: ソースプレビューの canvas 化

- `<video>` の一時停止 frame 表示を Mediabunny canvas に置き換える。
- playhead / seek bar / frame strip は共通 clock から更新する。
- 通常再生は `performance.now()` ベースの clock と exact frame decode で行う。

完了条件:

- `<video>.currentTime` なしで seek 結果のフレームが表示される。
- フレーム番号表示、上段 playhead、下段 frame strip が同じ frame index を指す。

### Phase 4: 音声プレビュー

- Mediabunny audio samples を WebAudio へ流す。
- シーケンス切り替え時に映像 frame clock と音声 clock を同期する。
- まず素材音声のみ対応し、BGM / mix / fade は別フェーズにする。

完了条件:

- 出力シーケンス再生で音声も素材順に鳴る。
- 停止、seek、素材境界で音ズレや残響が残らない。

### Phase 5: `<video>` と native fallback の削除

- `index.html` の `<video id="srcVideo">` を canvas へ置き換える。
- `fileOpen.urlFor()` と object URL 管理を削る。
- `probeDuration()` / `probeFps()` / `requestVideoFrameCallback` fallback を削る。

完了条件:

- 通常操作、サムネイル、下段ライン、出力プレビュー、書き出しがすべて Mediabunny/WebCodecs 主経路で動く。
- `<video>`、`MediaRecorder`、`canvas.captureStream()` が通常経路から消える。

## 検証項目

- 新規作業フォルダを選び、動画を追加しても `media/` や `cache/frames` が作られない。
- プロジェクトを開き直し、権限が残っていれば動画が自動復帰する。
- 権限がない場合は再リンク導線が出る。
- 上段タイムラインで素材を作成、移動、trim できる。
- 下段毎フレームラインで素材枠が表示され、frame 単位で移動・trim できる。
- 出力連続プレビューで素材末尾の不要フレームが見えない。
- 書き出し結果の映像境界が下段ラインと一致する。
- 音声あり素材を書き出した MP4 に音声が入る。
- 単一ソースでは source FPS が使われる。
- 複数ソースで FPS が異なる場合は選択できる。
- 出力解像度は長辺 1080 上限かつソース最大長辺に合わせられる。
