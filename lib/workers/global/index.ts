import is from '@sindresorhus/is';
import { ERROR } from 'bunyan';
import fs from 'fs-extra';
import { satisfies } from 'semver';
import upath from 'upath';
import * as pkg from '../../../package.json';
import * as configParser from '../../config';
import { GlobalConfig } from '../../config';
import { getProblems, logger, setMeta } from '../../logger';
import { setUtilConfig } from '../../util';
import * as hostRules from '../../util/host-rules';
import * as repositoryWorker from '../repository';
import { autodiscoverRepositories } from './autodiscover';
import { globalFinalize, globalInitialize } from './initialize';
import { Limit, isLimitReached } from './limits';

type RenovateConfig = configParser.RenovateConfig;
type RenovateRepository = configParser.RenovateRepository;

export async function getRepositoryConfig(
  globalConfig: RenovateConfig,
  repository: RenovateRepository
): Promise<RenovateConfig> {
  const repoConfig = configParser.mergeChildConfig(
    globalConfig,
    is.string(repository) ? { repository } : repository
  );
  repoConfig.localDir = upath.join(
    repoConfig.baseDir,
    `./repos/${repoConfig.platform}/${repoConfig.repository}`
  );
  await fs.ensureDir(repoConfig.localDir);
  delete repoConfig.baseDir;
  return configParser.filterConfig(repoConfig, 'repository');
}

function getGlobalConfig(): Promise<RenovateConfig> {
  return configParser.parseConfigs(process.env, process.argv);
}

function haveReachedLimits(): boolean {
  if (isLimitReached(Limit.Commits)) {
    logger.info('Max commits created for this run.');
    return true;
  }
  return false;
}

/* istanbul ignore next */
function checkEnv(): void {
  const range = pkg.engines.node;
  const rangeNext = pkg['engines-next']?.node;
  if (process.release?.name !== 'node' || !process.versions?.node) {
    logger.error(
      { release: process.release, versions: process.versions },
      'Unsupported node environment detected.'
    );
  } else if (!satisfies(process.versions?.node, range)) {
    logger.error(
      { versions: process.versions, range },
      'Unsupported node environment detected. Please update your node version.'
    );
  } else if (rangeNext && !satisfies(process.versions?.node, rangeNext)) {
    logger.warn(
      { versions: process.versions, range: rangeNext },
      'Unsupported node environment detected. Please check your node version.'
    );
  }
}

export async function start(): Promise<number> {
  let config: GlobalConfig;
  try {
    // read global config from file, env and cli args
    config = await getGlobalConfig();
    // initialize all submodules
    config = await globalInitialize(config);

    checkEnv();

    // autodiscover repositories (needs to come after platform initialization)
    config = await autodiscoverRepositories(config);
    // Iterate through repositories sequentially
    for (const repository of config.repositories) {
      if (haveReachedLimits()) {
        break;
      }
      const repoConfig = await getRepositoryConfig(config, repository);
      await setUtilConfig(repoConfig);
      if (repoConfig.hostRules) {
        hostRules.clear();
        repoConfig.hostRules.forEach((rule) => hostRules.add(rule));
        repoConfig.hostRules = [];
      }
      await repositoryWorker.renovateRepository(repoConfig);
      setMeta({});
    }
  } catch (err) /* istanbul ignore next */ {
    if (err.message.startsWith('Init: ')) {
      logger.fatal(err.message.substring(6));
    } else {
      logger.fatal({ err }, `Fatal error: ${String(err.message)}`);
    }
    if (!config) {
      // return early if we can't parse config options
      logger.debug(`Missing config`);
      return 2;
    }
  } finally {
    globalFinalize(config);
    logger.debug(`Renovate exiting`);
  }
  const loggerErrors = getProblems().filter((p) => p.level >= ERROR);
  if (loggerErrors.length) {
    logger.info(
      { loggerErrors },
      'Renovate is exiting with a non-zero code due to the following logged errors'
    );
    return 1;
  }
  return 0;
}
