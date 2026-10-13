import { createContext, useContext } from 'react';
import type { AudioVisualizationSource } from '../../contracts/player.ts';

/** Integration port only. The visualizer owns its visible-only frame loop. */
export const AudioVisualizationContext = createContext<AudioVisualizationSource | undefined>(undefined);
export const useAudioVisualizationSource = () => useContext(AudioVisualizationContext);
