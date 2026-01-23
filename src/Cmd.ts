import * as StatusItems from './StatusItems'
import * as Utils from './Utils'
import * as Vsc from 'vscode'

// export async function bindBoard() {
//     const curName = StatusItems..get()
//     const newName = await Vsc.window.showQuickPick(Utils.boardC.pickList())
//     const name = newName ? Utils.boardC.trim(newName) : curName
//     await Utils.boardC.set(name)
// }

export async function bindSetup(uri?: Vsc.Uri) {
    const curName = StatusItems.setupC.get()
    const newName = await Vsc.window.showQuickPick(StatusItems.setupC.pickList())
    const name = newName ? StatusItems.setupC.trim(newName) : curName
    // await Utils.boardC.set('')
    await StatusItems.setupC.set(name)
    // Utils.updateConfig()
}

export function build(uri: Vsc.Uri, cid: string) {
    const opt = cid === 'em.buildLoad' ? '--load' : cid === 'em.buildMeta' ? '--meta' : ''
    // if (Utils.isUnitFile(uri)) {
    //     let upath = Utils.mkUpath(uri)
    //     Utils.build(upath, opt)
    // }
    // else {
    //     Vsc.window.showErrorMessage('not a unit')
    // }
}


