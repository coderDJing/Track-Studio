import type { ILayoutConfig } from 'src/types/globals'

type MainWindowSizeMigration = {
  version: number
  minWidth: number
  minHeight: number
}

export const MAIN_WINDOW_SIZE_MIGRATIONS: MainWindowSizeMigration[] = [
  {
    version: 1,
    minWidth: 1200,
    minHeight: 720
  },
  {
    version: 2,
    minWidth: 1260,
    minHeight: 720
  },
  {
    version: 3,
    minWidth: 1260,
    minHeight: 780
  }
]

const latestMainWindowSizeMigration = MAIN_WINDOW_SIZE_MIGRATIONS[
  MAIN_WINDOW_SIZE_MIGRATIONS.length - 1
] ?? {
  version: 0,
  minWidth: 900,
  minHeight: 600
}

const MAIN_WINDOW_DEFAULT_WIDTH = latestMainWindowSizeMigration.minWidth
const MAIN_WINDOW_DEFAULT_HEIGHT = latestMainWindowSizeMigration.minHeight
export const MAIN_WINDOW_MIN_WIDTH = latestMainWindowSizeMigration.minWidth
export const MAIN_WINDOW_MIN_HEIGHT = 650

export const defaultLayoutConfig: ILayoutConfig = {
  libraryAreaWidth: 175,
  songsAreaSplitLeftRatio: 0.5,
  isMaxMainWin: false,
  mainWindowWidth: MAIN_WINDOW_DEFAULT_WIDTH,
  mainWindowHeight: MAIN_WINDOW_DEFAULT_HEIGHT,
  mainWindowSizeMigrationVersion: latestMainWindowSizeMigration.version,
  miniPlayerWindowWidth: 960,
  miniPlayerWindowAlwaysOnTop: true
}
