# Disposable Video Editor / 使いすて動画エディター

https://tomosud.github.io/video_edit/

ブラウザだけで動く、シンプルな動画編集アプリ。
複数の動画から欲しい部分を切り出して並べ、字幕付きの縦(9:16)・横(16:9)の MP4 を書き出せます。

プロジェクトはブラウザの中に、15個まで保存され、いずれ消えます。

A simple video editor that runs entirely in your browser.
Cut the parts you want from multiple videos, arrange them, and export captioned vertical (9:16) and horizontal (16:9) MP4s.

Up to 15 projects are stored in your browser. They are temporary and will eventually be deleted.

<img width="1915" height="951" alt="image" src="https://github.com/user-attachments/assets/90c6eda1-7708-480c-a4f0-5a37afa880f0" />

## 使い方

https://github.com/user-attachments/assets/953d0831-4a85-46a3-9171-0978622b70f7



1. `Add Video` で動画を追加(ボタンへのドロップも可)
2. `1 Cut / Split` タイムラインの空白をダブルクリックしてカットを作成、ドラッグで範囲調整
3. `2 Cut Stock` のカードを `3 Edit` へドラッグして並べる
4. 字幕は `3 Edit` の字幕レーンをダブルクリックで追加、もう一度ダブルクリックで入力
5. プレビューをダブルクリックすると縦・横それぞれのクロップを調整できる
6. `ExportVideo` で MP4 を書き出し(縦・横・両方)

## How to use
1. `Add Video` to add videos (drag & drop onto the button also works)
2. Double-click empty space on the `1 Cut / Split` timeline to make a cut, drag to adjust
3. Drag cards from `2 Cut Stock` into `3 Edit`
4. Double-click the caption lane in `3 Edit` to add a caption, double-click it again to type
5. Double-click a preview to adjust its vertical / horizontal crop
6. `ExportVideo` to export MP4 (vertical, horizontal, or both)



## 注意 / Notes

- 編集内容はブラウザ内に一時保存されます(最近の約15セッションまで)。ブラウザのサイトデータ削除などで消えるため、完成したら必ず書き出してください。
- 対応ブラウザ: Chrome / Edge。

- Edits are saved temporarily in your browser (about the latest 15 sessions). They can disappear when site data is cleared, so always export finished videos.
- Supported browsers: Chrome / Edge.

## Acknowledgements

Video metadata, frame access, and export are powered by [Mediabunny](https://github.com/Vanilagy/mediabunny).

## License

MIT. See LICENSE.
