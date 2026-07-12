# エクスポート高速化・メモリ対策 実装指示

対象: `js/export.js`, `js/drawing.js`。AI アシスタント向けの段階的実装指示。
**1ステージずつ実装し、ユーザーのブラウザ確認を経てから次へ進むこと。**

前提知識:
- エクスポートは `exportProject()`(js/export.js)が Mediabunny(`lib/mediabunny.min.js`)の
  WebCodecs ラッパーで行う。クリップごとに「音声を全部 add → 映像を1フレームずつ
  getCanvas → canvasSource.add」の流れ。
- js を変更したら `index.html` のキャッシュバスター版文字列を全行同一値で一括更新する(CLAUDE.md 参照)。
- 各ステージ完了時に `node --check js/export.js` 等の構文チェックを行い、実動画での確認はユーザーに依頼する。

---

## Stage 1: デコードの逐次イテレータ化(最重要・速度) ✅ 完了 (2026-07-12)

実装済み: `getFrameCanvas()` を削除し、クリップごとに出力フレーム→ソースタイムスタンプ列を
事前生成して `videoSink.canvasesAtTimestamps(timestamps)` の `for await` で逐次デコードに変更。
`cropForItem` はクリップ単位で不変のためループ外へ移動。キャッシュバスター 20260712s → 20260712t。

**問題**: `getFrameCanvas()` が出力フレームごとに `videoSink.getCanvas(t)` を呼ぶ。
これは単発シーク用 API で、毎回シーク+デコードのラウンドトリップが発生し
パイプライン化されない。Mediabunny 公式も連続取得には `canvases()` /
`canvasesAtTimestamps()` を使うよう明記している(min.js に存在確認済み)。

**変更**:
1. クリップごとの映像ループ(`for localFrame ...`)の前に、そのクリップの全出力フレームに
   対応するソースタイムスタンプ列を生成する(現行の `sourceFrame` 計算と同一のマッピング:
   `clamp(round((inTime + localFrame/fps) * sourceFps), inFrame, outFrame-1) / sourceFps`)。
2. `session.videoSink.canvasesAtTimestamps(timestamps)` の `for await` に置き換え、
   得た canvas ごとに現行と同じ描画(crop → drawCaption)→ `canvasSource.add` を行う。
3. `getFrameCanvas()` は不要になれば削除。
4. タイムスタンプ列は単調非減少なのでそのまま渡せる(同一値の連続も可、Mediabunny は
   同一フレームを再利用する)。

**注意**: `CanvasSink` は `poolSize: 3` で生成されている。イテレータが canvas を
再利用するため、描画は受け取った直後に行う(現行構造のままで問題ない)。

**検証**: 構文チェック後、ユーザーに短いクリップと複数クリップ構成でエクスポートしてもらい、
出力が従前と同一に見えること・所要時間の変化を報告してもらう。

## Stage 2: バックグラウンドタブ耐性(速度・体感最大要因の可能性) ✅ 完了 (2026-07-12)

実装済み: `nextBreath()` を rAF+setTimeout のレースから MessageChannel ベースの yield に変更
(タイマースロットリング対象外)。`exportProject()` を `navigator.locks.request('viralcut-export', ...)`
で包み、Web Lock 保持で Chrome の intensive throttling を回避(locks 非対応環境は素通し)。
本体は `runExport()` に改名。キャッシュバスター 20260712t → 20260712u。

**問題**: `nextBreath()` は rAF と `setTimeout(50ms)` のレース。バックグラウンドタブでは
rAF が止まり、setTimeout は Chrome のスロットリングで最低1秒、タブが5分裏にいると
「1分に1回」まで絞られる。8フレームごとに待つため最悪 8フレーム/分に落ちる。

**変更**:
1. `nextBreath()` を MessageChannel ベースの yield に変更(message イベントは
   タイマースロットリングの対象外):
   ```js
   const breathChannel = new MessageChannel();
   let breathResolve = null;
   breathChannel.port1.onmessage = () => { breathResolve?.(); breathResolve = null; };
   function nextBreath() {
     return new Promise((resolve) => { breathResolve = resolve; breathChannel.port2.postMessage(0); });
   }
   ```
2. `exportProject()` 全体を `navigator.locks.request('viralcut-export', fn)` で包む
   (Web Lock 保持中は Chrome の intensive throttling が無効になる)。
   `navigator.locks` が無い環境では素通しにする。

**検証**: ユーザーにエクスポート中に別タブへ切り替えてもらい、進捗が止まらないことを確認。

## Stage 3: 背景ブラー描画の軽量化(速度) ✅ 完了 (2026-07-12)

実装済み: `drawBlurBackground()` を、共有スクラッチ canvas に 1/4 解像度で
`blur(blurPx/4)` をかけてから出力へ拡大描画する方式に変更(BLUR_SHRINK=4)。
cover フィット・1.08 オーバースキャン・globalAlpha の合成は従前と同一。
プレビュー/サムネイル/エクスポート共通経路。キャッシュバスター 20260712u → 20260712v。

**問題**: `drawBlurBackground()`(js/drawing.js)が毎フレーム出力解像度で
`ctx.filter = blur(24px)` を実行する。Canvas 2D のフィルタブラーは高コストで、
1080p では 1 フレーム数十 ms になり得る。

**変更**:
1. モジュール内に再利用するオフスクリーン canvas を持ち、ソースを 1/4 解像度に縮小して
   `blur(blurPx / 4)` をかけ、それを出力 canvas に拡大描画する
   (ブラー半径は縮小率で割ることで見た目を維持)。
2. `drawing.js` はプレビュー・サムネイル・エクスポート共通なので、変更後にプレビューの
   見た目が変わっていないかユーザーに確認してもらう。差が気になる場合は縮小率を 1/2 に。

**検証**: ブラー背景が出る縦動画クロップ(ズームアウト・パン端)でプレビューと
エクスポート結果を目視比較してもらう。

## Stage 4: 出力のストリーム書き出し(メモリ・長尺対応の本命) ✅ 完了 (2026-07-12)

実装済み:
- `export.js`: `runExport` に `writable` オプション追加。指定時は `StreamTarget(writable, { chunked: true })`
  でディスクへ直接書き出し(戻り値 null)、未指定時は従来の BufferTarget + Blob。
  finalize 時に StreamTarget が writable を自動 close(=ファイル確定)することを min.js で確認済み。
  エラー時は `output.cancel()` で後始末(部分ファイルは残る)。
- `app.js`: `pickExportDestination()` 追加(showSaveFilePicker → createWritable)。
  非対応/activation 切れは Blob ダウンロードへフォールバック、ピッカーのキャンセルは
  エクスポート中止。`prepareExportSettings` の順序を「ファイル名 prompt → モード選択」に変更
  (モードボタンのクリックを直近の user activation にしてピッカーを確実に開くため)。
  デュアル書き出しの2本目は activation 消費済みのため自動的にダウンロード方式になる(既知の制限)。
- `mediabunny.js`: `StreamTarget` を再エクスポートに追加。
- ファイルハンドルは保存・永続化しない(プロジェクトフォルダ保存の再導入ではない)。
- キャッシュバスター 20260712v → 20260712w。

**問題**: `BufferTarget` が出力 MP4 全体を RAM に保持する。ビットレートは
`W×H×fps×0.16` なので 1080×1920@60fps ≈ 20Mbps ≈ 150MB/分。20分で約3GB、
さらに `new Blob([target.buffer])` でコピーがもう1つ発生し、タブのメモリ上限を超える。

**変更**(Chrome/Edge 前提。File System Access API 使用):
1. エクスポート開始時に `showSaveFilePicker({ suggestedName: 'viralcut.mp4', types: [mp4] })`
   で保存先を取得し、`createWritable()` を得る。
   - ユーザー操作(ボタンクリック)のハンドラ内で呼ぶこと(user activation 必須)。
   - これは書き出し先の単発選択であり、プロジェクトフォルダ保存の再導入ではない
     (ハンドルは保存・永続化しない)。
2. `BufferTarget` を `StreamTarget(writable)` に置き換える。Mediabunny の StreamTarget は
   `{ data, position }` を発行するので、FileSystemWritableFileStream の seek 付き write で
   そのまま受けられる。`Mp4OutputFormat` は `fastStart: false` を明示(全量バッファ回避)。
3. `finalize()` 後に `writable.close()`。`downloadBlob()` 経由のダウンロードは不要になる。
4. キャンセル/エラー時は `writable.abort()` で後始末。
5. `showSaveFilePicker` が無い・ユーザーがキャンセルした場合は従来の
   BufferTarget + downloadBlob にフォールバックする(短尺ならそれで足りる)。

**検証**: ユーザーに長め(10分以上)の構成でエクスポートしてもらい、
タスクマネージャでタブのメモリが増え続けないこと、出力 mp4 が再生できることを確認。

## Stage 5: keyFrameInterval の単位修正(品質・小) ✅ 完了 (2026-07-12)

実装済み: `keyFrameInterval: Math.max(1, Math.round(fps * 2))`(=60、秒単位なので60秒に
1キーフレームだった)を `2`(2秒ごと)に修正。

同時実施(ユーザー要望のエクスポート UX 改善, 2026-07-12):
- ファイル名 prompt の初期値にも `sanitizeFileName` を適用(日付由来の `:` `/` は `_` に)。
  `sanitizeFileName` は Windows で不正な末尾ドット/空白も除去するよう強化。
- both モードのファイル名サフィックスを `-vertical/-horizontal` → `_vertical/_horizontal` に変更。
- 書き出し先の選択を1回に: 単体モードは showSaveFilePicker、both モードは
  showDirectoryPicker(readwrite)を1回だけ開き、既存ファイルの上書き確認を
  エクスポート開始前に askConfirm でまとめて行う。両ターゲットの writable を先に確保するので
  2本目もストリーム書き出しになる(Stage 4 の既知の制限を解消)。
- セッション選択リストのタイトルに、日付ベースのセッション名に続けて exportName を表示
  (`name · exportName`)。exportName は従来どおり project state として保存済み。
- Export ratio ダイアログ: 並びを Horizontal / Vertical / Both に変更し、比率を表す
  □ アイコン(CSS の .ratio-rect)を各ボタンに追加。
- キャッシュバスター 20260712w → 20260712x。

**問題**: `CanvasSource` に `keyFrameInterval: Math.round(fps * 2)` を渡しているが、
Mediabunny のこのオプションは**秒単位**(デフォルト5秒)。現状は「60秒に1キーフレーム」に
なっている可能性が高く、出力動画のシークが重くなる。

**変更**: Mediabunny のドキュメント/型定義で単位を確認のうえ、意図(2秒ごと)どおり `2` にする。

**検証**: 出力 mp4 をプレーヤーでシークして引っかかりが減ることを確認。

## Stage 6(任意): エクスポート fps の見直し

これは現状では不要
現在はソース fps の最大値(上限60)を自動採用するため、60fps ソースでは 30fps 比で
デコード・描画・エンコードが全て2倍になる。長尺用に「30fps に落とす」選択肢を
エクスポート UI に出すことを検討(ユーザーと相談のうえ実施)。

---

## 実施順の理由

- Stage 1, 2 は挙動を変えずに速度だけ改善するため最初。
- Stage 3 は見た目にわずかに影響し得るためユーザー確認を挟む。
- Stage 4 は UI フロー(保存先ダイアログ)が変わるため独立して確認する。
- 各ステージでキャッシュバスター更新と `node --check` を忘れないこと。
