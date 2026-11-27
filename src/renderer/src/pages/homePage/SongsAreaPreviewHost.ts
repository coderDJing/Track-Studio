import { defineComponent } from 'vue'
import { useWaveformPreviewPlayer } from '../modules/songsArea/composables/useWaveformPreviewPlayer'

// One preview player for the song list and iCloud library, independent of the number or order of panes.
export default defineComponent({
  setup() {
    useWaveformPreviewPlayer()
    return () => null
  }
})
