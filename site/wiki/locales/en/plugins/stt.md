# Speech-to-Text (beilu-stt)

beilu-stt lets you speak instead of type. Press the microphone button, record, and review the transcription in the input box before sending it.

It runs a local MOSS-Transcribe-Diarize model rather than a cloud speech API. This is STT only: speech becomes text. Beilu does not currently provide the reverse text-to-speech path through this plugin.

## Use it

1. Open Speech-to-Text in the extension/plugin panel and enable it.
2. On first use, download the model from the panel.
3. Press the microphone icon in the chat input, then press it again to stop.
4. Review the text inserted into the input before sending.

The transcription service starts on demand. First model load is slower than later recordings, and the panel should show startup progress.

## Model download

The current manual estimates the model at about 1.8 GB. It is downloaded separately and stored under the repository's moxin directory.

Available source strategies include automatic source selection, direct Hugging Face, hf-mirror, and ModelScope. Downloads support resume and source switching.

## Backend and browser recording

- **Backend recording (preferred):** the local service captures the microphone and can work with virtual devices that browsers sometimes fail to capture. It also supports device selection and server-side noise reduction.
- **Browser recording (fallback):** used when the backend recording path is unavailable.

Hotwords can improve proper-name recognition. The desktop companion microphone shares the same transcription service and device/noise-reduction configuration.

## Privacy and requirements

- Audio is intended for local model inference rather than a cloud STT endpoint.
- The service requires a working local Python environment and model dependencies.
- Confirm microphone permissions and the selected device before treating silence as a model failure.

## Troubleshooting

- **Download failed:** choose another source; partial downloads should resume.
- **Microphone does nothing:** inspect the panel's environment check for Python and dependencies.
- **First recording is slow:** wait for the model to load, then test a second recording.
- **Companion uses the wrong device:** verify the shared device setting and allow time for it to propagate.

## Continue

- [Plugin Manual](overview.md)
- [Screen Awareness](eye.md)
