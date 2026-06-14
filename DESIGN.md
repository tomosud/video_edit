# ViralCut — GitHub Pages Vertical Video Editor

## 概要

GitHub Pages にホストできる静的 Web アプリ。  
長尺動画（YouTube 素材など）を複数インポートし、縦型（9:16）10〜20 秒のバイラル動画にトリム・字幕付与・書き出しするツール。

---

## 要件

| 軸 | 内容 |
|---|---|
| ホスト | GitHub Pages（完全静的、サーバー不要） |
| 出力形式 | 縦型 9:16、H.264/AAC MP4 |
| クリップ長 | 目安 10〜20 秒 |
| 素材規模 | 1 時間級の大容量動画も想定 |
| エンコード | ブラウザ内完結（FFmpeg.wasm） |
| 文字起こし | ブラウザ内完結（Whisper.cpp WASM） |

---

## ユーザーワークフロー

```
動画ファイルを開く（File System Access API）
  │
  ├─ [字幕ドリブン] Whisper で文字起こし / VTT インポート
  │     → 字幕テキストで台詞を検索 → シーンをタイムスタンプで絞り込み
  │
  └─ [ビジュアルドリブン] サムネイルストリップをスキャン
        → トリムイン／アウトを目視で設定
  │
  両者共通 ↓
トリムポイント確定 → クリップをタイムライン下段に追加
  │
  ├─ 9:16 クロップ位置・パン調整（プレビュー）
  ├─ テキスト／字幕オーバーレイ編集
  └─ BGM 追加・音量調整
  │
FFmpeg.wasm でエンコード → MP4 ダウンロード
```

---

## データモデル（一貫ルール）

3種類のオブジェクトで全機能を構成する。これがツール全体の語彙。

| 種別 | 形 | 役割 |
|---|---|---|
| **Source** | `{id, fileName, duration, fps, …}` | 読み込んだ動画。メニューで選択 |
| **Material（切り出し素材）** | `{id, sourceId, in, out}` | ソースタイムライン上の帯＋素材置き場のカード。**再利用可** |
| **Output（出力クリップ）** | `{id, materialId, crop, texts}` | 素材を編集場所に置いたインスタンス。**クロップ等の編集はここ** |

**1つの選択状態 `selection={kind,id}` が全体を駆動**:
- 何かを選ぶと両プレビュー（元比率＋縦9:16）・ソースタイムラインの帯・素材カード・出力カードのハイライトが同期する。
- Output を選ぶと元の Material も同じハイライトになる（`selectedMaterialId()` で逆引き）。
- 編集（crop pan/zoom）対象は「選択中の Output」。Material 選択中はドラフト crop（`ui.crop`）。

## UI レイアウト（縦4段スタック / FHD 前提）

```
┌──────────────────────────────────────────────────────────┐
│ [新規][開く][保存] | [動画追加][ソース▼] | [↶][↷] | [書出] │  ← (1) メニュー
├──────────────────────────────────────────────────────────┤
│ ソースタイムライン                                         │  ← (2)
│  サムネイル（ホイールで無限ズーム）＋複数クリップ帯        │
│  ▐██[clip1]██▌    ▐███[clip2]███▌   …   │playhead         │
├───────────────┬──────────────────────┬───────────────────┤
│ 切り出し素材   │ 元比率プレビュー       │ 縦動画 9:16        │  ← (3)
│ [card][card]  │   <video>            │   Canvas          │
│ [card][card]  │   ▶ / ↻ループ        │   X / Y / Z スライダ│
├───────────────┴──────────────────────┴───────────────────┤
│ 出力クリップ（編集）  ← 素材をドロップ／並び替え           │  ← (4)
│ [out1][out2][out3] …                合計 0.0s             │
└──────────────────────────────────────────────────────────┘
```

### 操作ルール（ソースタイムライン）

- **ホイール** = カーソル位置を中心に無限ズーム（最小 ~2フレームまで）。ビューは「表示ウィンドウ `{start,end}`」方式で、見えている範囲のサムネイルだけを都度生成。
- **空クリック** = 一定幅（既定3秒）のクリップ生成＋選択。
- **空ドラッグ** = ビューを左右パン。
- **帯の本体ドラッグ** = クリップ移動、**端ドラッグ** = in/out トリム（ドラッグ全体で Undo 1ステップ）。
- **帯ダブルクリック** = その範囲をループ再生。
- 素材を選択すると、その範囲（＋両端やや外）にビューが自動フォーカス。

### 1080p（FHD）画面での視認性ルール

主ターゲット解像度は **1920×1080**。狭いノートではなく FHD デスクトップで「ひと目で全体が見える」ことを最優先にする。

- **固定4行レイアウト**: メニュー / ソースタイムライン / 素材＋プレビュー / 出力クリップ を CSS Grid 行（`50px 1.1fr 1.5fr 1fr`）で割り付け、縦スクロールなしで全機能が収まる。
- **最小フォント 14px、操作対象 32px 以上**: ボタン・ハンドル・トリムつまみは小さくしすぎない。サムネイル境界の IN/OUT ハンドルは掴みやすい幅（最低 12px のヒット領域）を確保。
- **9:16 プレビューは高さ基準**: 上段の縦型プレビューは利用可能な高さいっぱい（最大 ~900px）まで使い、幅は 9:16 から逆算。FHD なら原寸に近い確認ができる。
- **ハイ DPI 対応**: Canvas は `devicePixelRatio` 倍のバッキングストアで描画し、ストリップのサムネイル・字幕焼き込みプレビューがぼけないようにする。
- **ダークテーマ既定**: 長時間編集でも疲れにくい暗色 UI。アクセントカラー1色（IN=緑 / OUT=赤など状態色）。
- **情報密度の調整**: ストリップは横スクロール＋ズーム（Phase 1）。ズーム時はサムネイル間隔を細かく、引くと粗く。再生ヘッド・IN/OUT・字幕行を同一時間軸に重ねて表示。

---

## 技術スタック

| レイヤー | 技術 | 理由 |
|---|---|---|
| UI フレームワーク | Vanilla JS（ES Modules） | 依存ゼロ、GitHub Pages 相性◎ |
| 動画読み込み | File System Access API + `<video>` | 巨大ファイルをストリーミング、メモリ効率 |
| サムネイル生成 | WebCodecs API（`VideoDecoder`） | FFmpeg 不使用でフレーム高速展開 |
| エンコード／書き出し | FFmpeg.wasm（`@ffmpeg/ffmpeg`） | H.264 + クロップ + テキスト焼き込み |
| 文字起こし | whisper.wasm（`ggerganov/whisper.cpp` WASM ビルド） or `@xenova/transformers` Whisper | ローカル推論 |
| 字幕フォーマット | WebVTT（`.vtt`） | ブラウザネイティブ |
| スタイル | CSS Grid / Custom Properties | ライブラリ不要 |

> **FFmpeg.wasm の CORS 要件**: SharedArrayBuffer が必要。GitHub Pages は COOP/COEP ヘッダーを送らないため、`coi-serviceworker` ライブラリで代替する。

---

## ファイル構成

```
video_edit/
├── index.html
├── css/
│   └── style.css
├── js/
│   ├── app.js             # エントリ：配線・選択副作用・範囲ループ再生・永続化
│   ├── store.js           # 中央状態 + pub/sub + Undo/Redo + 自動保存（履歴もstore内）
│   ├── db.js              # IndexedDB（autosave/handles/history/models）
│   ├── projectStore.js    # プロジェクトフォルダ I/O（project.json / .gitignore / cache）
│   ├── fileOpen.js        # 動画読み込み・URL登録・再リンク
│   ├── frameCache.js      # フレームキャッシュ（メモリLRU + cache/ 書き戻し）
│   ├── thumbnails.js      # フレーム単位サムネイル生成（プールvideo + frameCache）
│   ├── sourceTimeline.js  # ズーム可能・複数クリップのソースタイムライン
│   ├── materialShelf.js   # 切り出し素材カード（選択・再生・出力へドラッグ）
│   ├── cropPreview.js     # 9:16 Canvas プレビュー（選択の crop を反映）
│   ├── outputSequence.js  # 出力クリップ（ドロップ・並び替え・選択・再生）
│   ├── util.js            # 時間フォーマット等
│   ├── export.js          # FFmpeg.wasm（MT/STフォールバック、outputs→materials）
│   ├── subtitles.js       # [Phase2] VTT パース・字幕行 UI
│   ├── whisper.js         # [Phase2] Whisper WASM ラッパー
│   ├── textOverlay.js     # [Phase2] テキスト／字幕オーバーレイ
│   └── bgm.js             # [Phase3] BGM 管理・音量
├── lib/
│   └── coi-serviceworker.js  # SharedArrayBuffer COOP/COEP 代替
└── run_local.bat

プロジェクトフォルダ（ユーザー側、git管理）:
my-project/
├── project.json          # sources/materials/outputs（編集情報）
├── subtitles/*.vtt
├── .gitignore            # media/ cache/ *.mp4 … を除外（自動生成）
├── media/                # 動画実体（gitignore済み）
└── cache/frames/<srcId>/<frame>.jpg   # フレームキャッシュ（gitignore済み）
```

---

## 永続化モデル — プロジェクトフォルダ + IndexedDB

編集状態は**二層**で保持する。役割を明確に分ける。

### ① プロジェクトフォルダ（ユーザーのローカル、git 管理対象）

「プロジェクト」= ユーザーが選んだ**ローカルフォルダ**。File System Access API のディレクトリハンドルで読み書きする。  
**動画本体（重い・git不要）は入れず、編集情報（軽い・git管理したい）だけを置く**ことで、フォルダごと git/Dropbox 等で管理できる。

```
my-project/                 ← これ自体が git リポジトリになりうる
├── project.json            # 全編集情報（下記スキーマ）
├── subtitles/
│   ├── source1.vtt         # 文字起こし・字幕（テキストなので git 向き）
│   └── source2.vtt
├── .gitignore              # 動画・一時ファイルを除外（アプリが自動生成）
└── media/                  # （任意）動画への参照置き場。実体は gitignore 済み
```

`.gitignore`（アプリが初回に書き出す）:
```
media/
*.mp4
*.mov
*.mkv
*.webm
```

> 動画ファイルは `project.json` 内に**相対パスとファイル名・サイズ・更新日時**で参照を記録する。再オープン時は同名ファイルを探し、見つからなければユーザーに再リンクを促す（ディレクトリハンドル経由で `media/` 内を走査）。実体は別管理（手元 or クラウド）でよい。

#### `project.json` スキーマ（ドラフト）

```jsonc
{
  "version": 1,
  "name": "my-viral-clip",
  "output": { "width": 1080, "height": 1920, "fps": 30 },
  "sources": [
    {
      "id": "src1",
      "fileName": "interview.mp4",
      "relPath": "media/interview.mp4",
      "size": 1234567890,
      "lastModified": 1700000000000,
      "duration": 3600.0,
      "subtitleFile": "subtitles/source1.vtt"
    }
  ],
  "clips": [
    {
      "id": "clip1",
      "sourceId": "src1",
      "in": 125.4,            // 秒
      "out": 138.9,
      "crop": { "panX": 0.5, "panY": 0.5, "zoom": 1.0 },  // 9:16 切り出し位置（0..1）
      "texts": [
        { "text": "ここがバズる", "tStart": 0.0, "tEnd": 3.0,
          "x": 0.5, "y": 0.85, "size": 64, "color": "#fff", "stroke": "#000" }
      ]
    }
  ],
  "bgm": { "fileName": "bgm.mp3", "relPath": "media/bgm.mp3",
           "gain": 0.3, "fadeIn": 0.5, "fadeOut": 1.0 },
  "savedAt": 1700000000000
}
```

「保存」= `project.json` と `subtitles/*.vtt` をフォルダへ書き戻すだけ。差分が git に綺麗に乗る。

### ② IndexedDB（ブラウザ内、作業バッファ）

リロードや突然のクラッシュで作業を失わないための**自動保存層**。git 管理対象ではない。

| ストア | 内容 | 目的 |
|---|---|---|
| `autosave` | 現在の編集状態（project.json と同形）＋ダーティフラグ | リロード復帰 |
| `handles` | プロジェクトフォルダ／動画のディレクトリ・ファイルハンドル | 再オープン時に権限再要求 |
| `history` | Undo/Redo スナップショット列（直近 N 件） | 履歴復帰 |
| `models` | Whisper モデルバイナリ | 再ダウンロード回避 |
| `thumbs` | サムネイル ImageBitmap キャッシュ（任意） | 再スキャン回避 |

- 編集のたびに `autosave` をデバウンス更新（例: 500ms）。
- ハンドルは `IDBObjectStore` に直接 `FileSystemHandle` を保存可能（structured clone 対応）。再訪時に `queryPermission`/`requestPermission` で再許可。
- **明示「保存」操作**でのみプロジェクトフォルダ（git対象）に書き出す。IndexedDB はあくまで下書き。

### Undo / Redo（`history.js`）

- **コマンド単位のスナップショット方式**: トリム変更・クリップ追加削除・並び替え・テキスト編集など「確定操作」ごとに編集状態（`clips`/`texts` などの軽量 JSON）を履歴スタックに push。
- ドラッグ中の連続更新は履歴に積まず、**ドロップ確定時に1スナップショット**（粒度の暴発防止）。
- `Ctrl+Z` / `Ctrl+Shift+Z`（または `Ctrl+Y`）。スタック上限（例 100）で古いものから破棄。
- 履歴も IndexedDB `history` に保存し、リロード後も直近の Undo を可能にする。
- JSON が軽量（参照とパラメータのみ、動画フレームは含まない）なのでスナップショット丸ごとでも十分軽い。

---

---

## 実装フェーズ

### Phase 1 — MVE（最小動作エディタ）

- [ ] `index.html` / `css/style.css` — レイアウト骨格
- [ ] `fileOpen.js` — File System Access API で動画を `<video>` に接続
- [ ] `thumbnails.js` — WebCodecs でサムネイルストリップ生成
- [ ] `trimTimeline.js` — IN/OUT ドラッグ + キーボードショートカット
- [ ] `clipList.js` — クリップ追加・並び替え・削除
- [ ] `cropPreview.js` — 9:16 Canvas プレビュー、パン操作
- [ ] `db.js` — IndexedDB ラッパー、`autosave` デバウンス保存・リロード復帰
- [ ] `history.js` — Undo/Redo スタック（`Ctrl+Z` / `Ctrl+Shift+Z`）
- [ ] `projectStore.js` — プロジェクトフォルダを開く／`project.json` 読み書き／`.gitignore` 生成
- [ ] `export.js` — FFmpeg.wasm でクロップ＋結合 MP4 書き出し
- [ ] `coi-serviceworker.js` 組み込み
- [ ] `run_local.bat` — ローカルテスト用サーバー起動

### Phase 2 — 字幕

- [ ] `subtitles.js` — VTT インポート＋字幕行クリックでシーク
- [ ] `whisper.js` — Whisper WASM 文字起こし（モデル選択 UI、`models` キャッシュ）
- [ ] `textOverlay.js` — 字幕テキストの Canvas 焼き込み設定

### Phase 3 — 仕上げ

- [ ] `bgm.js` — BGM トラック追加・フェード・音量
- [ ] 複数ソース動画切り替え（ドロップゾーン）
- [ ] 動画再リンク UI（プロジェクト再オープン時に欠落メディアを解決）
- [ ] モバイル対応（タッチ操作）

---

## 主要 API の制約と対策

### File System Access API + ストリーミング
- `showOpenFilePicker()` → `FileSystemFileHandle` → `File` → `URL.createObjectURL()` で `<video src>` に直接割り当て
- メモリにロードしない。Chrome/Edge のみ（Safari は 2024 時点で未サポートだが fallback として `<input type="file">` を用意）

### WebCodecs サムネイル
- `VideoDecoder` に `EncodedVideoChunk` を流してフレームを `ImageBitmap` で取得
- デマックスは MP4Box.js（`mp4box.js`）を使用

### Whisper.wasm
- モデルサイズ: tiny（75MB）→ base（145MB）→ small（465MB）
- 初回ロードは遅い。IndexedDB にキャッシュして 2 回目から高速化
- 文字起こし対象: FFmpeg.wasm で 16kHz モノラル WAV を抽出 → Whisper に渡す

### FFmpeg.wasm エクスポートコマンド例
```
ffmpeg
  -i clip1.mp4 -i clip2.mp4 ...       # 入力クリップ（仮想 FS）
  -filter_complex
    "[0:v]crop=ih*9/16:ih:(iw-ih*9/16)/2+<panX>:0,scale=1080:1920[v0];
     [1:v]crop=...[v1];
     [v0][v1]concat=n=2:v=1:a=0[vout];
     [0:a][1:a]concat=n=2:v=0:a=1[aout]"
  -map [vout] -map [aout]
  -c:v libx264 -preset fast -crf 23
  -c:a aac -b:a 128k
  output.mp4
```

### coi-serviceworker
- `coi-serviceworker.js` を `index.html` で最初に登録
- `Cross-Origin-Opener-Policy: same-origin` と `Cross-Origin-Embedder-Policy: require-corp` をフェイクヘッダーとして Service Worker が注入
- これにより `SharedArrayBuffer` が有効になり FFmpeg.wasm のマルチスレッドが動作
- **フォールバック**: `crossOriginIsolated` が false（iframe 埋め込みプレビュー等）の場合は `@ffmpeg/core`（シングルスレッド）を自動選択し、SharedArrayBuffer 無しでも書き出し可能にする。GitHub Pages のトップレベル遷移ではマルチスレッド版が有効になる。

---

## ローカルテスト（`run_local.bat`）

Service Worker と File System Access API は `file://` では動かないため、ローカルでも HTTP サーバーが必要。Python 標準ライブラリだけで完結するシンプルな bat にする。

```bat
@echo off
REM ViralCut ローカルサーバー起動
cd /d "%~dp0"
echo http://localhost:8000 をブラウザで開いてください
python -m http.server 8000
```

- ダブルクリックで起動 → `http://localhost:8000` を Chrome/Edge で開く。
- ポートは固定 8000（必要なら引数化）。Python があれば追加依存ゼロ。
- 本番の GitHub Pages と同じく Service Worker 経由で COOP/COEP が効くため、ローカルでも FFmpeg.wasm がそのまま動く。

> 注: `localhost` は secure context 扱いなので File System Access API / SharedArrayBuffer が許可される（`127.0.0.1` も可）。

---

## 未解決 / 検討事項

| 項目 | 状況 |
|---|---|
| Safari サポート | File System Access API 未対応 → `<input type="file">` fallback |
| Whisper モデル配布 | CDN（Hugging Face Hub）から動的ダウンロード or リポジトリに含めない |
| FFmpeg.wasm バージョン | `@ffmpeg/ffmpeg@0.12.x` (WebAssembly Core) が安定 |
| テキスト焼き込み | `drawtext` フィルタ or Canvas で事前レンダリング → 動画に合成 |
| プロジェクト保存 | Phase 3 以降。JSON に IN/OUT/クロップ/テキスト情報を保存 |
