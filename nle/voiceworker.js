// A voice worker: the editor's instruments played off the audio thread (voices.js).
import { runVoiceWorker } from './voices.js';

runVoiceWorker(self);
