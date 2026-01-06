import * as Fs from 'fs'
import * as Path from 'path'

const root = process.argv[2]

let jsonObj: Record<string, any> = JSON.parse(Fs.readFileSync('icon-theme.json', 'utf-8'))
const fnObj: Record<string, string> = {};

for (const p of Fs.readdirSync(root)) {
    fnObj[p] = 'package'
    for (const b of Fs.readdirSync(Path.join(root, p))) {
        if (Fs.statSync(Path.join(root, p, b)).isDirectory()) {
            fnObj[b] = 'bucket'
        }
    }
}
jsonObj['folderNames'] = fnObj
Fs.writeFileSync('icon-theme.json', JSON.stringify(jsonObj, null, 4))

