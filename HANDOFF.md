# ViralCut 開発引き継ぎメモ（HANDOFF）

最終更新: 2026-06-14

このドキュメントは、ViralCut（GitHub Pages 向け縦型動画エディタ）の開発を引き継ぐ人に向けて、
**「なぜ今こうなっているか（実装理由）」「何が未解決か」「何が未実装か」** を伝えるためのものです。
全体設計は [DESIGN.md](DESIGN.md) を、データモデルやレイアウトの意図はそちらを参照してください。
ここでは設計書に書かれていない「実装の現実」と「ハマりどころ」を中心に記録します。

---

## 0. 30秒サマリ

- バニラ JS（ES Modules、依存ゼロ）。ビルド工程なし。`python -m http.server 8000` で動く。
- 長尺動画をインポート → ソースタイムラインで切り出し（Material）→ 出力クリップ（Output）に並べて 9:16 クロップ → MP4 書き出し。
- **書き出しは ffmpeg.wasm をやめ、ブラウザネイティブ録画（MediaRecorder）方式に変更済み**。これが今回の最大の方針転換（理由は §3）。
- 字幕／Whisper／テキストオーバーレイ／BGM は **未実装**（DESIGN.md では Phase2/3 として計画のみ）。

---

## 1. 動かし方 / 開発環境

```powershell
# リポジトリ直下で
python -m http.server 8000
# ブラウザで http://localhost:8000/index.html を開く
```

- 対応ブラウザ: **Chrome / Edge**（File System Access API・`requestVideoFrameCallback`・MediaRecorder MP4 が必要）。
- `run_local.bat` でローカルサーバ起動も可。

### 重要なハマりどころ: coi-serviceworker のキャッシュ
- `lib/coi-serviceworker.js` は SharedArrayBuffer に必要な COOP/COEP ヘッダーを Service Worker で代替する。
- **副作用として JS を強くキャッシュする**。コードを編集したら必ず **Ctrl+Shift+R（ハードリロード）**。
  通常リロードだと古い JS が動き続け、「直したのに直らない」状態になる。
- 古い ffmpeg インスタンスがキャッシュに残ることもある。挙動が変なときはまずハードリロード。

---

## 2. アーキテクチャ要点（コードを読む前に）

- **中央 store（[js/store.js](js/store.js)）** が唯一の状態。pub/sub（`subscribe`）で各ビューが再描画。Undo/Redo・IndexedDB 自動保存もここ。
- **データモデルは3種**（DESIGN.md と一致）:
  - `Source {id, fileName, relPath, mediaKey, duration, fps, …}` 読み込んだ動画
  - `Material {id, sourceId, in, out}` 切り出し範囲（再利用可）
  - `Output {id, materialId, crop:{panX,panY,zoom}, texts:[]}` 並べて編集するインスタンス
- **単一の `selection={kind,id}`** が全ビューのハイライト・プレビュー・編集対象を駆動する。
- 主要モジュールの責務は DESIGN.md「ファイル構成」を参照。

---

## 3. 【最重要】書き出しパイプラインの変更理由

`js/export.js` は数回作り直している。**現在はブラウザネイティブ録画方式**。経緯を必ず理解してから触ること。

### 3.1 当初の方針（ffmpeg.wasm で完結）と、なぜ失敗したか

DESIGN.md の当初計画は「FFmpeg.wasm で trim + 9:16 crop + concat → MP4」。
これは **大容量・AV1 ソースで動かなかった**。順に潰した障害:

1. **Worker 構築エラー** `Failed to construct 'Worker'`
   - 原因: ffmpeg の `worker.js` をクロスオリジン（unpkg）から `new Worker()` できない。
   - 対処: `worker.js` を fetch → 相対 import を絶対 URL に書き換え → 同一オリジン blob 化（`classWorkerURL`）。
   - ※この対処は現在のフォールバック transcode 経路に残っている（§3.3）。

2. **`File could not be read! Code=-1`**
   - 原因: `FileSystemFileHandle` から一度取得した `File` が時間経過で無効化（stale）。
   - 対処: `fileOpen.freshFileFor(sourceId)` で**読む直前にハンドルから File を取り直す**（権限再要求つき）。これは今も有用なので残してある。

3. **`Array buffer allocation failed`**
   - 原因: `ff.writeFile(全バイト)` が動画全体を 1 つの Uint8Array として確保 → wasm メモリ上限超過。
   - 対処として WORKERFS マウントを試す → 次の 4 が発生。

4. **WORKERFS マウントで `Resource temporarily unavailable`（EAGAIN）連発 → `Missing Sequence Header` / `Cannot determine format after EOF`**
   - 原因: WORKERFS のファイル読み込みがデムクサに対して EAGAIN を返し続け、データが届かない。
     特に AV1 はシーケンスヘッダを読めず即死。
   - **single-thread / multi-thread どちらのコアでも解消しなかった**（試済み）。
   - ※`-ss` を入力前に置く「入力シーク」も AV1 でシーケンスヘッダを飛ばして失敗する。出力側シーク（`-i` の後ろに `-ss/-t`）に直したが、根本の EAGAIN は別問題。

→ 結論: **ffmpeg.wasm にこの巨大 AV1 を直接食わせる経路は全滅**。一方で **ブラウザのネイティブデコーダは同じ動画をプレビュー再生できている**。この非対称性が解決のヒントになった。

### 3.2 現在の方式（ブラウザネイティブ録画）

[js/export.js](js/export.js) `exportProject()` の流れ:

1. 出力クリップを解決し、ソースごとに `freshFileFor` → `URL.createObjectURL` で `<video>` 用 URL を用意。
2. オフスクリーン `<canvas>`（出力解像度 1080×1920）を作り、**プレビューと同じクロップ計算**でフレームを描画（`drawFrame`）。クロップ式は [js/cropPreview.js](js/cropPreview.js) と一致させている（ズレたら両方直す）。
3. 音声は WebAudio で `createMediaElementSource(video) → MediaStreamDestination` にタップ。
4. `canvas.captureStream(fps)` の映像トラック + 音声トラックを 1 本の `MediaStream` にまとめ、**1 つの `MediaRecorder` で全クリップを連続録画**（クリップ境界で `pause()/resume()`）。
5. 再生は `requestVideoFrameCallback`（無ければ rAF）で各フレームを canvas に描き、`material.out` 到達で停止。
6. **MP4 を直接録画できる環境ならそのまま MP4**。できなければ WebM で録り、**その小さなクロップ済み出力だけ** ffmpeg.wasm で MP4 に変換（§3.3）。

メリット: 巨大 AV1・メモリ・WORKERFS の問題を**すべて回避**。ブラウザが再生できる動画なら何でも書き出せる。

### 3.3 ffmpeg.wasm の役割（縮小して残存）
- 現在 ffmpeg.wasm は **「録画した小さい WebM → MP4」変換のフォールバックだけ**に使う（`transcodeToMp4`）。
- 入力はクロップ済みの数 MB〜程度なので、`writeFile` でメモリに載せても問題ない。
- Chrome/Edge は MP4 録画に対応していることが多く、その場合 ffmpeg は**一切呼ばれない**。

### 3.4 現方式のトレードオフ / 既知の弱点（未解決）
- **リアルタイム録画**: 書き出し時間 ≒ 合計クリップ尺（10秒の素材なら約10秒）。長尺の連結だと時間がかかる。
- **タブの可視性依存**: 録画中にタブを裏に回すと rAF / captureStream が間引かれ、フレーム落ち・尺ズレの恐れ。書き出し中はタブを前面に保つ前提。
- **フレーム精度はベストエフォート**: `requestVideoFrameCallback` 基準だが、シーク誤差・端数フレームで厳密なフレーム一致は保証しない。
- **音声の頭/尻**: クリップ境界の `pause()/resume()` で稀に音のつなぎ目が出る可能性（要検証）。
- **ビットレート固定**: `videoBitsPerSecond: 12Mbps` 決め打ち。UI で可変にしていない。

---

## 4. その他の実装済み機能と、その理由

- **fps 自動検出**（[js/fileOpen.js](js/fileOpen.js) `probeFps`）
  - `requestVideoFrameCallback` で連続フレームの時間差を測り、一般的なレート（23.976/24/25/29.97/30/50/59.94/60/120）にスナップ。3秒タイムアウトで 30 にフォールバック。
  - 理由: 実素材（配信切り抜き等）は 59.94/60fps が多く、**30fps 決め打ちだとサムネイルのフレーム境界とトリムのスナップ単位がズレる**問題があったため。古いプロジェクトは `relinkAll` で後追い補完。
- **フレーム単位サムネイル**（[js/thumbnails.js](js/thumbnails.js)）
  - ズーム時（`framePx >= 22px`）は 1 フレーム = 1 セルでフレーム境界に正確配置。引いたらサンプリング表示。
  - キャッシュキーは `source.mediaKey`（ファイル名+サイズの SHA-256 先頭）。**同じ動画なら再オープンでもキャッシュ再利用**。
- **メディアのプロジェクトフォルダコピー**（[js/projectStore.js](js/projectStore.js) `copyIntoMedia`）
  - 動画を選ぶと `media/`（gitignore 済み）へストリーミングコピー。サムネイルキャッシュはハッシュ名で識別。
- **シークバー / オーバービュー（俯瞰）/ スムーズ再生ヘッド / クリップ端追従**
  - シークは `util.makeScrubber`（seek をまとめて rAF に載せ、`seeking` 解決を待って最新位置へ）。「ドラッグで高速シーク」要件のため。
  - クリップ端ドラッグ時は再生位置をその端に追従させ、編集結果を即確認できるようにした。
- **削除機能**（Delete/Backspace + 確認ダイアログ）
  - Output 削除は Material を残す。Material 削除は依存 Output も巻き込み、件数を確認メッセージに出す（データモデルの親子関係を尊重）。
- **無限ループ・フリーズ修正**（[js/materialShelf.js](js/materialShelf.js) / [js/outputSequence.js](js/outputSequence.js)）
  - 症状: ページが固まる。原因は IndexedDB 復元後に「Material はあるがメディア未リンク」状態で、サムネ生成が必ず失敗 → `thumbSig` が更新されず finally の「位置変わった？」判定が常に真 → **無限再生成ループ**。
  - 対処: `ok` 成功フラグを立て、成功時だけ次位置を追う。新規ブラウザで再現しなかったのは Material が 0 件だったため。

---

## 5. 未実装（DESIGN.md にあるが、まだ無い機能）

| 機能 | 状態 | 補足 |
|---|---|---|
| 字幕パース / VTT インポート（`subtitles.js`） | **未実装** | ファイル自体が無い。DESIGN.md の Phase2。 |
| Whisper 文字起こし（`whisper.js`） | **未実装** | whisper.wasm or transformers.js の想定のみ。 |
| テキスト/字幕オーバーレイ（`textOverlay.js`） | **未実装** | `Output.texts` は常に空配列。書き出しの canvas 描画に**焼き込みフックを足せば対応可能**（`drawFrame` の後にテキスト描画を追加する設計）。 |
| BGM 追加・音量調整（`bgm.js`） | **未実装** | 音声は現状ソース音のみ。WebAudio グラフに BGM ノードを足す余地あり。 |
| 字幕ドリブン検索（台詞で絞り込み） | **未実装** | 文字起こしが前提。 |
| 出力解像度/fps/ビットレートの UI 設定 | **未実装** | `project.json.output` は持つが UI 露出なし。export はそこを読む。 |

### 「テキスト焼き込み」を実装する人へのヒント
現在の録画方式なら ffmpeg のフィルタ地獄は不要。`exportProject` 内 `drawFrame` 直後に、
`output.texts` を canvas に `ctx.fillText` で描けばそのまま録画に焼き込まれる。プレビュー（cropPreview.js）にも同じ描画を足せば WYSIWYG になる。

---

## 6. 未解決・要注意（バグ/リスク）

1. **長尺書き出しのリアルタイム所要時間**（§3.4）。高速化したいなら WebCodecs（`VideoEncoder`/`VideoDecoder`）でのオフライン・等速以上エンコードへの移行が本命。ただし実装コスト大。
2. **書き出し中のタブ非アクティブでフレーム落ち**（§3.4）。警告 UI を出すか、`document.visibilityState` を監視して一時停止する等の対策が未実装。
3. **フレーム厳密一致は未保証**（§3.4）。フレーム単位の正確さが要る用途では要追加検証。
4. **再リンク UX**: メディアが見つからない/権限切れ時の導線はあるが洗練不足。`freshFileFor` が権限を再要求するが、ユーザー操作起点でないと弾かれる場合がある。
5. **エラー表示**: `app.js` の `guard()` が `alert` で素朴に出す。長い ffmpeg ログがそのまま出ることがある。
6. **DESIGN.md の記述が一部古い**: 「サムネイルは WebCodecs」「エンコードは FFmpeg.wasm」とあるが、実際はサムネは `<video>` シーク方式、書き出しは MediaRecorder 方式。**DESIGN.md の技術スタック表は本書 §3 で上書きされていると理解すること**（次の更新で DESIGN.md 側も直すのが望ましい）。

---

## 7. 触るときのチェックリスト

- [ ] JS を編集したら **Ctrl+Shift+R**（coi-serviceworker キャッシュ）。
- [ ] クロップ計算を変えたら [js/cropPreview.js](js/cropPreview.js) と [js/export.js](js/export.js) `drawFrame` の**両方**を一致させる。
- [ ] 書き出しの検証は「MP4 直接録画」と「WebM→MP4 変換」の**両経路**を意識（`MediaRecorder.isTypeSupported` の結果で分岐）。
- [ ] 大容量 AV1 を**わざわざ ffmpeg.wasm に直接食わせない**（§3 の歴史を繰り返さない）。
- [ ] ユーザー要望: **Playwright 自動実行はしない**。確認は console.log を仕込んでユーザーが目視する運用。

---

## 8. 参考: 失敗した代替案（再挑戦しないための記録）

- ffmpeg.wasm `writeFile` 全読み込み → メモリ確保失敗。
- ffmpeg.wasm WORKERFS マウント → EAGAIN 連発でデコード不能（MT/ST 両方）。
- 入力前 `-ss`（高速入力シーク）→ AV1 でシーケンスヘッダ欠落。
- これらは **巨大 AV1 では再現性高く失敗**。ブラウザネイティブ録画が現状の最適解。
