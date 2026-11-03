import path = require('path')
import store from '../store'
import { getCoreFsDirName } from '../coreLibraries'

export const SET_CUSTODY_DIR_NAME = '__set_custody__'

export function getSetCustodyDirAbs(): string {
  return path.join(
    store.databaseDir,
    'library',
    getCoreFsDirName('SetLibrary'),
    SET_CUSTODY_DIR_NAME
  )
}
