import { readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import type { ExecSyncOptions } from 'node:child_process'
import { execSync, spawnSync } from 'node:child_process'
import process from 'node:process'
import * as p from '@clack/prompts'
import type LogSnag from 'logsnag'
import semver from 'semver'
import tmp from 'tmp'
import { markSnag, waitLog } from './app/debug'
import { createKey } from './key'
import { addChannel } from './channel/add'
import { uploadBundle } from './bundle/upload'
import { doLoginExists, login } from './login'
import { addAppInternal } from './app/add'
import { checkLatest } from './api/update'
import type { Options } from './api/app'
import type { Organization } from './utils'
import { convertAppName, createSupabaseClient, findBuildCommandForProjectType, findMainFile, findMainFileForProjectType, findProjectType, findSavedKey, getConfig, getOrganization, getPMAndCommand, useLogSnag, verifyUser } from './utils'

interface SuperOptions extends Options {
  local: boolean
}
const importInject = 'import { CapacitorUpdater } from \'@capgo/capacitor-updater\''
const codeInject = 'CapacitorUpdater.notifyAppReady()'
// create regex to find line who start by 'import ' and end by ' from '
const regexImport = /import.*from.*/g
const defaultChannel = 'production'
const execOption = { stdio: 'pipe' }

let tmpObject: tmp.FileResult['name'] | undefined

function readTmpObj() {
  if (!tmpObject) {
    tmpObject = readdirSync(tmp.tmpdir)
      .map((name) => { return { name, full: `${tmp.tmpdir}/${name}` } })
      .find(obj => obj.name.startsWith('capgocli'))?.full
      ?? tmp.fileSync({ prefix: 'capgocli' }).name
  }
}

function markStepDone(step: number) {
  try {
    readTmpObj()
    writeFileSync(tmpObject!, JSON.stringify({ step_done: step }))
  }
  catch (err) {
    p.log.error(`Cannot mark step as done in the CLI, error:\n${err}`)
    p.log.warn('Onboarding will continue but please report it to the capgo team!')
  }
}

async function readStepsDone(orgId: string, snag: LogSnag): Promise<number | undefined> {
  try {
    readTmpObj()
    const rawData = readFileSync(tmpObject!, 'utf-8')
    if (!rawData || rawData.length === 0)
      return undefined

    const { step_done } = JSON.parse(rawData)
    p.log.info(`You have already got to the step ${step_done}/10 in the previous session`)
    const skipSteps = await p.confirm({ message: 'Would you like to continue from where you left off?' })
    await cancelCommand(skipSteps, orgId, snag)
    if (skipSteps)
      return step_done
    return undefined
  }
  catch (err) {
    p.log.error(`Cannot read which steps have been compleated, error:\n${err}`)
    p.log.warn('Onboarding will continue but please report it to the capgo team!')
    return undefined
  }
}

function cleanupStepsDone() {
  if (!tmpObject) {
    return
  }

  try {
    rmSync(tmpObject)
  }
  catch (err) {
    p.log.error(`Cannot delete the tmp steps file.\nError: ${err}`)
  }
}

async function cancelCommand(command: boolean | symbol, orgId: string, snag: LogSnag) {
  if (p.isCancel(command)) {
    await markSnag('onboarding-v2', orgId, snag, 'canceled', '🤷')
    process.exit()
  }
}

async function markStep(orgId: string, snag: LogSnag, step: number | string) {
  return markSnag('onboarding-v2', orgId, snag, `onboarding-step-${step}`)
}

async function step2(organization: Organization, snag: LogSnag, appId: string, options: SuperOptions) {
  const pm = getPMAndCommand()
  const doAdd = await p.confirm({ message: `Add ${appId} in Capgo?` })
  await cancelCommand(doAdd, organization.gid, snag)
  if (doAdd) {
    const s = p.spinner()
    s.start(`Running: ${pm.runner} @capgo/cli@latest app add ${appId}`)
    const addRes = await addAppInternal(appId, options, organization, false)
    if (!addRes)
      s.stop(`App already add ✅`)
    else
      s.stop(`App add Done ✅`)
  }
  else {
    p.log.info(`If you change your mind, run it for yourself with: "${pm.runner} @capgo/cli@latest app add ${appId}"`)
  }
  await markStep(organization.gid, snag, 2)
}

async function step3(orgId: string, snag: LogSnag, apikey: string, appId: string) {
  const pm = getPMAndCommand()
  const doChannel = await p.confirm({ message: `Create default channel ${defaultChannel} for ${appId} in Capgo?` })
  await cancelCommand(doChannel, orgId, snag)
  if (doChannel) {
    const s = p.spinner()
    // create production channel public
    s.start(`Running: ${pm.runner} @capgo/cli@latest channel add ${defaultChannel} ${appId} --default`)
    const addChannelRes = await addChannel(defaultChannel, appId, {
      default: true,
      apikey,
    }, false)
    if (!addChannelRes)
      s.stop(`Channel already added ✅`)
    else
      s.stop(`Channel add Done ✅`)
  }
  else {
    p.log.info(`If you change your mind, run it for yourself with: "${pm.runner} @capgo/cli@latest channel add ${defaultChannel} ${appId} --default"`)
  }
  await markStep(orgId, snag, 3)
}

const urlMigrateV6 = 'https://capacitorjs.com/docs/updating/6-0'
const urlMigrateV5 = 'https://capacitorjs.com/docs/updating/5-0'
async function step4(orgId: string, snag: LogSnag, apikey: string, appId: string) {
  const pm = getPMAndCommand()
  const doInstall = await p.confirm({ message: `Automatic Install "@capgo/capacitor-updater" dependency in ${appId}?` })
  await cancelCommand(doInstall, orgId, snag)
  if (doInstall) {
    const s = p.spinner()
    s.start(`Checking if @capgo/capacitor-updater is installed`)
    let versionToInstall = 'latest'
    const pack = JSON.parse(readFileSync('package.json').toString())
    let coreVersion = pack.dependencies['@capacitor/core'] || pack.devDependencies['@capacitor/core']
    coreVersion = coreVersion?.replace('^', '').replace('~', '')
    if (!coreVersion) {
      s.stop('Error')
      p.log.warn(`Cannot find @capacitor/core in package.json, please run \`capgo init\` in a capacitor project`)
      p.outro(`Bye 👋`)
      process.exit()
    }
    else if (semver.lt(coreVersion, '5.0.0')) {
      s.stop('Error')
      p.log.warn(`@capacitor/core version is ${coreVersion}, please update to Capacitor v5 first: ${urlMigrateV5}`)
      p.outro(`Bye 👋`)
      process.exit()
    }
    else if (semver.lt(coreVersion, '6.0.0')) {
      s.stop(`@capacitor/core version is ${coreVersion}, please update to Capacitor v6: ${urlMigrateV6} to access the best features of Capgo`)
      versionToInstall = '^5.0.0'
    }
    if (pm.pm === 'unknown') {
      s.stop('Error')
      p.log.warn(`Cannot reconize package manager, please run \`capgo init\` in a capacitor project with npm, pnpm, bun or yarn`)
      p.outro(`Bye 👋`)
      process.exit()
    }
    // // use pm to install capgo
    // // run command pm install @capgo/capacitor-updater@latest
    //  check if capgo is already installed in package.json
    if (pack.dependencies['@capgo/capacitor-updater']) {
      s.stop(`Capgo already installed ✅`)
    }
    else {
      await execSync(`${pm.installCommand} @capgo/capacitor-updater@${versionToInstall}`, execOption as ExecSyncOptions)
      s.stop(`Install Done ✅`)
    }
  }
  else {
    p.log.info(`If you change your mind, run it for yourself with: "${pm.installCommand} @capgo/capacitor-updater@latest"`)
  }
  await markStep(orgId, snag, 4)
}

async function step5(orgId: string, snag: LogSnag, apikey: string, appId: string) {
  const doAddCode = await p.confirm({ message: `Automatic Add "${codeInject}" code and import in ${appId}?` })
  await cancelCommand(doAddCode, orgId, snag)
  if (doAddCode) {
    const s = p.spinner()
    s.start(`Adding @capacitor-updater to your main file`)
    const projectType = await findProjectType()
    let mainFilePath
    if (projectType === 'unknown')
      mainFilePath = await findMainFile()
    else
      mainFilePath = await findMainFileForProjectType(projectType)

    if (!mainFilePath) {
      s.stop('Error')
      p.log.warn('Cannot find main file, You need to add @capgo/capacitor-updater manually')
      p.outro(`Bye 👋`)
      process.exit()
    }
    // open main file and inject codeInject
    const mainFile = readFileSync(mainFilePath)
    // find the last import line in the file and inject codeInject after it
    const mainFileContent = mainFile.toString()
    const matches = mainFileContent.match(regexImport)
    const last = matches?.pop()
    if (!last) {
      s.stop('Error')
      p.log.warn(`Cannot find import line in main file, use manual installation: https://capgo.app/docs/plugin/installation/`)
      p.outro(`Bye 👋`)
      process.exit()
    }

    if (mainFileContent.includes(codeInject)) {
      s.stop(`Code already added to ${mainFilePath} ✅`)
    }
    else {
      const newMainFileContent = mainFileContent.replace(last, `${last}\n${importInject};\n\n${codeInject};\n`)
      writeFileSync(mainFilePath, newMainFileContent)
      s.stop(`Code added to ${mainFilePath} ✅`)
    }
    await markStep(orgId, snag, 5)
  }
  else {
    p.log.info(`Add to your main file the following code:\n\n${importInject};\n\n${codeInject};\n`)
  }
}

async function step6(orgId: string, snag: LogSnag, apikey: string, appId: string) {
  const pm = getPMAndCommand()
  const doEncrypt = await p.confirm({ message: `Automatic configure end-to-end encryption in ${appId} updates?` })
  await cancelCommand(doEncrypt, orgId, snag)
  if (doEncrypt) {
    const s = p.spinner()
    s.start(`Running: ${pm.runner} @capgo/cli@latest key create`)
    const keyRes = await createKey({ force: true }, false)
    if (!keyRes) {
      s.stop('Error')
      p.log.warn(`Cannot create key ❌`)
      p.outro(`Bye 👋`)
      process.exit(1)
    }
    else {
      s.stop(`key created 🔑`)
    }
    markSnag('onboarding-v2', orgId, snag, 'Use encryption')
  }
  await markStep(orgId, snag, 6)
}

async function step7(orgId: string, snag: LogSnag, apikey: string, appId: string) {
  const pm = getPMAndCommand()
  const doBuild = await p.confirm({ message: `Automatic build ${appId} with "${pm.pm} run build" ?` })
  await cancelCommand(doBuild, orgId, snag)
  if (doBuild) {
    const s = p.spinner()
    const projectType = await findProjectType()
    const buildCommand = await findBuildCommandForProjectType(projectType)
    s.start(`Running: ${pm.pm} run ${buildCommand} && ${pm.runner} cap sync`)
    const pack = JSON.parse(readFileSync('package.json').toString())
    // check in script build exist
    if (!pack.scripts[buildCommand]) {
      s.stop('Error')
      p.log.warn(`Cannot find ${buildCommand} script in package.json, please add it and run \`capgo init\` again`)
      p.outro(`Bye 👋`)
      process.exit()
    }
    execSync(`${pm.pm} run ${buildCommand} && ${pm.runner} cap sync`, execOption as ExecSyncOptions)
    s.stop(`Build & Sync Done ✅`)
  }
  else {
    p.log.info(`Build yourself with command: ${pm.pm} run build && ${pm.runner} cap sync`)
  }
  await markStep(orgId, snag, 7)
}

async function step8(orgId: string, snag: LogSnag, apikey: string, appId: string) {
  const pm = getPMAndCommand()
  const doBundle = await p.confirm({ message: `Automatic upload ${appId} bundle to Capgo?` })
  await cancelCommand(doBundle, orgId, snag)
  if (doBundle) {
    const s = p.spinner()
    s.start(`Running: ${pm.runner} @capgo/cli@latest bundle upload`)
    const uploadRes = await uploadBundle(appId, {
      channel: defaultChannel,
      apikey,
    }, false)
    if (!uploadRes) {
      s.stop('Error')
      p.log.warn(`Upload failed ❌`)
      p.outro(`Bye 👋`)
      process.exit()
    }
    else {
      s.stop(`Upload Done ✅`)
    }
  }
  else {
    p.log.info(`Upload yourself with command: ${pm.runner} @capgo/cli@latest bundle upload`)
  }
  await markStep(orgId, snag, 8)
}

async function step9(orgId: string, snag: LogSnag) {
  const pm = getPMAndCommand()
  const doRun = await p.confirm({ message: `Run in device now ?` })
  await cancelCommand(doRun, orgId, snag)
  if (doRun) {
    const plaformType = await p.select({
      message: 'Pick a platform to run your app',
      options: [
        { value: 'ios', label: 'IOS' },
        { value: 'android', label: 'Android' },
      ],
    })
    if (p.isCancel(plaformType)) {
      p.outro(`Bye 👋`)
      process.exit()
    }

    const platform = plaformType as 'ios' | 'android'
    const s = p.spinner()
    s.start(`Running: ${pm.runner} cap run ${platform}`)
    await spawnSync(pm.runner, ['cap', 'run', platform], { stdio: 'inherit' })
    s.stop(`Started Done ✅`)
  }
  else {
    p.log.info(`If you change your mind, run it for yourself with: ${pm.runner} cap run <ios|android>`)
  }
  await markStep(orgId, snag, 9)
}

async function step10(orgId: string, snag: LogSnag, apikey: string, appId: string) {
  const doRun = await p.confirm({ message: `Automatic check if update working in device ?` })
  await cancelCommand(doRun, orgId, snag)
  if (doRun) {
    p.log.info(`Wait logs sent to Capgo from ${appId} device, Put the app in background and open it again.`)
    p.log.info('Waiting... (there is a usual delay of 15 seconds until the backend process the logs)')
    await waitLog('onboarding-v2', apikey, appId, snag, orgId)
  }
  else {
    const appIdUrl = convertAppName(appId)
    p.log.info(`Check logs in https://web.capgo.app/app/p/${appIdUrl}/logs to see if update works.`)
  }
  await markStep(orgId, snag, 10)
}

export async function initApp(apikeyCommand: string, appId: string, options: SuperOptions) {
  const pm = getPMAndCommand()
  p.intro(`Capgo onboarding 🛫`)
  await checkLatest()
  const snag = useLogSnag()
  const config = await getConfig()
  appId = appId || config?.app?.appId
  const apikey = apikeyCommand || findSavedKey()

  const log = p.spinner()
  if (!doLoginExists() || apikeyCommand) {
    log.start(`Running: ${pm.runner} @capgo/cli@latest login ***`)
    await login(apikey, options, false)
    log.stop('Login Done ✅')
  }

  const supabase = await createSupabaseClient(apikey)
  await verifyUser(supabase, apikey, ['upload', 'all', 'read', 'write'])

  const organization = await getOrganization(supabase, ['admin', 'super_admin'])
  const orgId = organization.gid

  const stepToSkip = await readStepsDone(orgId, snag) ?? 0

  try {
    if (stepToSkip < 1)
      await markStep(orgId, snag, 1)

    if (stepToSkip < 2) {
      await step2(organization, snag, appId, options)
      markStepDone(2)
    }

    if (stepToSkip < 3) {
      await step3(orgId, snag, apikey, appId)
      markStepDone(3)
    }

    if (stepToSkip < 4) {
      await step4(orgId, snag, apikey, appId)
      markStepDone(4)
    }

    if (stepToSkip < 5) {
      await step5(orgId, snag, apikey, appId)
      markStepDone(5)
    }

    if (stepToSkip < 6) {
      await step6(orgId, snag, apikey, appId)
      markStepDone(6)
    }

    if (stepToSkip < 7) {
      await step7(orgId, snag, apikey, appId)
      markStepDone(7)
    }

    if (stepToSkip < 8) {
      await step8(orgId, snag, apikey, appId)
      markStepDone(8)
    }

    if (stepToSkip < 9) {
      await step9(orgId, snag)
      markStepDone(9)
    }

    await step10(orgId, snag, apikey, appId)
    await markStep(orgId, snag, 0)
    cleanupStepsDone()
  }
  catch (e) {
    console.error(e)
    p.log.error(`Error during onboarding, please try again later`)
    process.exit(1)
  }

  p.log.info(`Welcome onboard ✈️!`)
  p.log.info(`Your Capgo update system is setup`)
  p.log.info(`Next time use \`${pm.runner} @capgo/cli@latest bundle upload\` to only upload your bundle`)
  p.outro(`Bye 👋`)
  process.exit()
}
