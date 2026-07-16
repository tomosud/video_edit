# ViralCut Current Implementation

Last updated: 2026-07-16

このファイルは、現在の実装状態を次回作業用にまとめたものです。

## 概要

ViralCut はブラウザだけで動くローカル動画編集ツールです。

- vanilla JavaScript ES modules で構成。
- bundler は使っていない。
- Mediabunny / WebCodecs / IndexedDB を利用。
- 動画ファイルはユーザーがブラウザで追加する。
- プロジェクトファイルとして永続保存する仕様ではない。
- 編集途中の復帰は IndexedDB の一時セッションで行う。
- 書き出しはブラウザのダウンロードとして MP4 を出す。

基本ワークフロー:

1. `Add Video` でローカル動画を追加。
2. `1 Cut / Split` で動画を切り出して cut stock を作る。
3. `2 Cut Stock` から素材を確認する。
4. `3 Edit` に並べて編集シーケンスを作る。
5. 必要なら字幕とクロップを調整する。
6. `ExportVideo` で縦・横・両方を書き出す。

## UI 構成

### Header

- `New / Sessions`
  - セッション選択画面を開く。
  - 新規作成ボタンは `New Session`。
- `Add Video`
  - 動画ファイル追加。
  - ドロップ追加にも対応。
- Source picker
  - ネイティブ `select` は非表示。
  - サムネイル付きの独自ピッカーを表示。
  - 先頭が黒い動画でも分かりやすいよう、少し途中のフレームをサムネイルに使う。
- `Undo` / `Redo`
- `ExportVideo`

### 1 Cut / Split

ソース動画を切り分ける領域です。

- 上段に俯瞰タイムラインを表示。
- 中段にズーム可能なソースタイムラインを表示。
- 下段に細めのフレームストリップを表示。
- 俯瞰タイムラインは常にソース全体を表示する。
- 俯瞰タイムラインの表示範囲窓を操作して、ズーム中の表示位置を動かせる。
- ソースタイムラインは wheel zoom / right-drag pan。
- シングルクリックでプレビュー位置へシーク。
- 空白をダブルクリックすると cut stock を作成。
- 既存カットをダブルクリックするとカット編集モード。
- 編集モードのカットは移動・左右リサイズできる。
- 新規セッションやソース切替時は、俯瞰タイムラインも明示的にクリアして再生成する。

### 2 Cut Stock

切り出した素材のストックとプレビュー領域です。

- 素材は `Used in edit` と `Unused` に分けて表示。
- 使用済みと未使用を同じ一覧内で見分けられる。
- Material サムネイルは horizontal crop を反映する。
- サムネイルサイズはホイールで変更可能。
- Material を選択すると、Edit タイムライン上の対応 clip が破線で目立つ。
- 横プレビュー `Horizontal Preview 16:9` と縦プレビュー `Vertical Preview 9:16` を並べて表示。
- どちらもダブルクリックで crop edit mode。
- 横クロップと縦クロップは独立した値を持つ。
- Area 2とArea 3の間の横スプリッターを上下ドラッグして、両エリアの高さを変更できる。
- 字幕作業を広げたい時はスプリッターを上へドラッグする。ダブルクリックで初期高さへ戻る。

### 3 Edit

出力シーケンスの編集領域です。

- cut card の横幅は時間比例。
- 短い cut も最低幅を持つ。
- wheel zoom / right-drag pan。
- cut card はドラッグで並び替え。
- ドロップ位置が cut 間に確定しそうな時、点滅する insert marker を表示。
- 再生シークバーは cut サムネイルの下端に配置。
- playhead はドラッグで edit playback をシーク。
- ズームして cut card が広い時だけ、開始・中央・終了の 3 サムネイル表示。
- ズームアウト時は従来通り中央サムネイル中心。
- `Play From Start` は編集シーケンスの先頭から再生。
- `Pause` は `Resume` に切り替わる。
- play info は `Edit playing` / `Cut range` / `Source playing` などで現在の再生文脈を表示。
- 字幕入力中の `Caption / Title` 切替ボタンは、字幕バーの上側へ出してカットタイムラインに重ねる。

## 字幕

字幕は material ではなく output clip instance に属します。

現在の基本形:

```js
{
  id: 'out_...',
  materialId: 'mat_...',
  captions: [
    {
      id: 'cap_...',
      text: '',
      secondaryText: '',
      sourceAnchorMs: 0,
      startOffsetMs: -500,
      endOffsetMs: 1500
    }
  ]
}
```

仕様:

- 1つの output clip に複数字幕を持てる。
- 字幕は属している clip の前後にはみ出せる。
- 字幕のアンカーは edit sequence time ではなく、元動画の source time で持つ。
- これにより、動画内の出来事に対して字幕を追従させる。
- cut が短くなって anchor が範囲外になる場合は、cut 端に clamp して anchor time も更新。
- 字幕バー本体のドラッグは anchor ごと移動。
- 字幕バー左右端のドラッグは表示範囲だけ変更。
- 字幕バーを別 cut 上まで移動すると、その cut に所属を変更。
- 空き領域のダブルクリックで字幕バーを追加。
- 追加幅は他字幕と重ならない空白部分に収める。
- 字幕バーのダブルクリックで直接テキスト編集。
- `Delete` / `Backspace` で選択字幕を確認付き削除。

表示:

- primary text は白。
- secondary text は黄色。
- second language 用に 2 列入力。
- `🌐 Auto: On` にすると、Primaryの内容を実際のSecond欄へ複製する。
- AutoボタンはEditヘッダー右側のTotal手前に配置する。
- OffからOnにする時は、Secondを上書きする確認ダイアログを表示し、`Run` でのみコピーする。
- アプリ本体は `translate="no"`、Secondの表示と編集欄だけは `translate="yes"` としてブラウザ翻訳の対象にする。
- Auto を有効にしてから Chrome / Edge のページ翻訳で第二言語を選ぶと、表示中のSecond欄のDOM変化を `secondaryText` へ戻す。
- 翻訳結果は通常の字幕データとしてIndexedDBに保存され、プレビューと縦・横MP4書き出しに黄色字幕として入る。
- 外部翻訳API、APIキー、サーバーは使わない。ページ翻訳を実行しない場合は自動入力されない。
- 改行がある場合、字幕時間内で行ごとに順番表示。
- 行が切り替わる時、時間に余裕があれば約 0.2 秒だけ文字と背景を消す。
- 時間が足りない場合は 0.2 秒ギャップを省略する。
- 縦動画で収まらない場合は折り返しとフォント縮小で調整。
- 文字密度が高い字幕は warning / danger 色で可視化。

## セッション

現在はプロジェクト保存ではなく、一時セッション方式です。

- `New / Sessions` でセッション画面を開く。
- 新規ボタンは `New Session`。
- 新規セッション作成時に unique id を作り URL query に入れる。
- URL が違えば、同じブラウザで複数ページを開いて別動画を編集できる。
- IndexedDB に保存する。
- 保存対象は最近約 15 セッション。
- 「約」としているのは、操作タイミングや pruning の都合で厳密な見え方に揺れがあるため。
- 古いセッションほど暗く表示し、消える順番を示す。
- セッション単位でストレージ容量を表示。
- セッション画面ではサムネイルクリックでも開ける。
- 削除ボタンでセッション削除可能。
- セッションサムネイルは edit がある時だけ edit 由来を保存。

IndexedDB stores:

- `sessions`
- `sessionHistory`
- `sessionMedia`
- legacy / cache 系:
  - `autosave`
  - `history`
  - `media`
  - `handles`
  - `models`
  - `thumbs`

保存条件:

- `sessionId` がある。
- cut stock が 1 つ以上ある。
- material-only session は保存する。
- video-only session は保存しない。
- undo/redo history も session ごとに保存。
- video `File` object はブラウザが許す範囲で session ごとに IndexedDB に保存。

警告文:

- セッションは一時保存。
- ブラウザのサイトデータ削除、空き容量不足、シークレット終了、最近約15セッション外などで消える。
- 永続保存ではないことを強く見せるため、セッション画面にゴミ箱アイコン付き warning を表示。

## データモデル

Project:

```js
{
  version: 2,
  name: 'untitled',
  output: { width: 1080, height: 1920, fps: 30 },
  sources: [],
  materials: [],
  outputs: [],
  bgm: null,
  savedAt: 0
}
```

Source:

```js
{
  id,
  fileName,
  mediaKey,
  size,
  lastModified,
  duration,
  fps,
  width,
  height,
  hasAudio
}
```

Material:

```js
{
  id,
  sourceId,
  in,
  out,
  title,
  horizontalCrop,
  crop
}
```

Output:

```js
{
  id,
  materialId,
  captions: []
}
```

UI state:

- active source
- selected material/output
- selected caption
- source timeline view range
- vertical crop draft
- horizontal crop draft
- edit material ids
- crop edit mode flags

## Export

- `ExportVideo` で export mode dialog を開く。
- `Vertical 9:16`
- `Horizontal 16:9`
- `Both`
- vertical export は material の vertical crop を使う。
- horizontal export は horizontal crop を使う。
- 字幕は export frame に描画される。
- second language も黄色字幕として描画。
- fps: ソース間で不一致なら最大値に合わせる。上限 60fps。ダイアログでは聞かない。
- 音声: 全サンプルを 44100Hz / 2ch / f32 に変換してから encoder に渡す(mono は複製、48kHz などは線形リサンプル)。
- 音声なし(またはデコード不可)のソースは同フォーマットの無音で埋め、トラックのパラメータを一定に保つ。

## 主要ファイル

- `index.html`: UI 構造。importmap でモジュールのキャッシュバスターを一元管理。
- `css/style.css`: レイアウト、タイムライン、字幕、セッション画面。
- `js/app.js`: アプリ全体の結線、セッション画面、source picker、再生状態、export entry。
- `js/store.js`: 中央 state、undo/redo、session autosave、保存失敗通知。
- `js/db.js`: IndexedDB wrapper、session prune、容量推定。
- `js/fileOpen.js`: 動画追加、IndexedDB media restore、object URL 管理。
- `js/sourceTimeline.js`: `1 Cut / Split`、俯瞰タイムライン、cut band 編集。
- `js/frameStrip.js`: 下段の frame strip。
- `js/materialShelf.js`: `2 Cut Stock`。
- `js/outputSequenceTimeline.js`: `3 Edit`、cut 並び替え、字幕バー、edit playhead。
- `js/captions.js`: 字幕タイミング、密度、折り返し、canvas 描画、プレビュー用字幕解決。
- `js/browserTranslation.js`: PrimaryからSecondへの複製、表示中のSecond欄から翻訳結果を取得。
- `js/drawing.js`: 縦・横クロップ描画とブラー背景の共通実装。preview / thumbnail / export はすべてここを使い、見た目を一致させる。
- `js/horizontalPreview.js`: 16:9 preview。
- `js/cropPreview.js`: 9:16 preview。
- `js/export.js`: MP4 書き出し。

## 実行

```bat
run_local.bat
```

Open:

```text
http://127.0.0.1:8000/
```

UI 更新が出ない場合は hard reload の後、`index.html` の importmap 内バージョン文字列(例: `20260712a`)を一括置換で上げる。

キャッシュバスターの仕組み:

- `js/` 内の import 文にはクエリを付けない。
- `index.html` の importmap が全モジュールを同一バージョンのクエリ付き URL に固定する。
- これにより一部モジュールだけ古い版が混ざる事故(過去の store.js 二重ロードバグ)が構造的に起きない。
- COOP/COEP 用 service worker は削除済み(SharedArrayBuffer 不使用のため不要)。起動時に旧登録を unregister する。

## 確認コマンド

```powershell
Get-ChildItem js/*.js | ForEach-Object { node --check $_.FullName }
git diff --check
```

## 直近のリファクタリング (2026-07-11)

安全性・負荷・保守性の改善。UI 挙動は変えていない。

- importmap によるキャッシュバスター一元化(`js/` 内 import のクエリ全廃)。
- 未使用ファイル削除: `outputSequence.js` / `clipList.js` / `trimTimeline.js` / `previewSequence.js` / `projectStore.js` / `lib/coi-serviceworker.js`。
- 字幕テキスト編集が undo 1 ステップとして記録されるようになった。
- autosave / 動画 File 保存の失敗をステータス表示に出す(`store.setPersistErrorHandler`)。
- 起動時のストレージ失敗で空編集にフォールバック(白画面防止)。
- export 中のバックグラウンドタブでフリーズしない(rAF と timer の race)。
- セッション切替時に Mediabunny デコードセッションを破棄(リーク防止)。
- export 時に同一ファイルなら object URL を revoke しない(プレビュー破壊防止)。
- undo 履歴の IndexedDB 書き込みをデバウンス、shelf / edit タイムラインの store 購読 render を rAF に集約。
- クロップ描画を `js/drawing.js` に、プレビュー字幕解決を `js/captions.js` に共通化。`escapeHtml` は `js/util.js` に集約。
- source ドロップダウンの fileName エスケープ漏れ修正。

## ブラウザ自動翻訳モード (2026-07-16)

- Editヘッダーに `🌐 Auto: Off / On` を追加。
- Auto On時にPrimaryを実際のSecond欄へコピーし、Second欄だけをブラウザ翻訳対象にした。
- Chrome / Edgeのページ翻訳が変更した表示中のSecond欄を監視し、字幕の `secondaryText` へundo可能な更新として反映する。
- Second編集欄を翻訳可能なcontenteditableにし、手入力も従来通り可能にした。
- 実ブラウザでのGoogle翻訳動作と動画上の見た目は未確認。

## 字幕作業領域の調整 (2026-07-16)

- 字幕入力中のCaption / Title切替を入力欄の下から上へ移動した。
- Area 2とArea 3の間に高さ調整用スプリッターを追加した。
- 狭い画面ではArea 2/3の最小高さと初期Edit高さを小さくする。

## 既知の注意点

- セッションは永続保存ではない。
- IndexedDB に保存した video `File` もブラウザ都合で消える可能性がある。
- source native playback は厳密な frame-perfect ではない場合がある。
- export / Mediabunny frame read の方が preview playback より決定的。
- durable project file save/open は現時点では実装しない方針。
