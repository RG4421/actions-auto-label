import * as fs from 'fs';
import * as path from 'path';
import { Toolkit } from 'actions-toolkit';
import { addLabelsToLabelable, removeLabelsFromLabelable, getPullRequestAndLabels } from './query';
import { Label, FileEdge, LabelEdge, LabelName } from './interface';
import { getLabelIds } from './util';
import * as util from 'util';
import ignore from 'ignore';

const exec = util.promisify(require('child_process').exec);
const configFile = '.github/auto-label.json';
const tools = new Toolkit({
  event: ['pull_request.opened', 'pull_request.synchronize'],
});

(async () => {
  if (!fs.existsSync(path.join(tools.workspace, configFile))) {
    tools.exit.neutral('config file does not exist.');
  }

  const config = JSON.parse(tools.getFile(configFile));

  let result;

  try {
    result = await getPullRequestAndLabels(tools, tools.context.issue());
  } catch (error) {
    console.error('Request failed: ', error.request, error.message);
    tools.exit.failure('getPullRequestAndLabels has been failed.');
  }

  console.log('Result: ', result);

  const allLabels = result.repository.labels.edges.reduce((acc: Label, edge: LabelEdge) => {
    acc[edge.node.name] = edge.node.id;
    return acc;
  }, {});

  const currentLabelNames = new Set(
    result.repository.pullRequest.labels.edges.map((edge: LabelEdge) => edge.node.name),
  );

  const { headRefOid, baseRefOid } = result.repository.pullRequest;

  // TODO: handle stderr
  const { stdout, stderr } = await exec(
    `git merge-base --is-ancestor ${baseRefOid} ${headRefOid} && git diff --name-only ${baseRefOid} || git diff --name-only $(git merge-base ${baseRefOid} ${headRefOid})`,
  );

  const diffFiles = stdout.trim().split('\n');

  const newLabelNames = new Set(
    diffFiles.reduce((acc: LabelName[], file: string) => {
      Object.entries(config.rules).forEach(([label, pattern]) => {
        if (
          ignore()
            .add(pattern as any)
            .ignores(file)
        ) {
          acc.push(label);
        }
      });
      return acc;
    }, []),
  );

  const ruledLabelNames = new Set(Object.keys(config.rules));

  const labelNamesToAdd = new Set(
    ([...newLabelNames] as LabelName[]).filter(labelName => !currentLabelNames.has(labelName)),
  );

  const labelNamesToRemove = new Set(
    ([...currentLabelNames] as LabelName[]).filter(
      (labelName: string) => !newLabelNames.has(labelName) && ruledLabelNames.has(labelName),
    ),
  );

  console.log(' ---> Current status');
  console.log('allLabels: ', allLabels);
  console.log('currentLabelNames: ', currentLabelNames);
  console.log('diffFiles: ', diffFiles);
  console.log('newLabelNames: ', newLabelNames);
  console.log('ruledLabelNames: ', ruledLabelNames);
  console.log('labelNamesToAdd: ', labelNamesToAdd);
  console.log('labelNamesToRemove: ', labelNamesToRemove);

  const labelableId = result.repository.pullRequest.id;

  if (labelNamesToAdd.size > 0) {
    try {
      await addLabelsToLabelable(tools, {
        labelIds: getLabelIds(allLabels, [...labelNamesToAdd] as LabelName[]),
        labelableId,
      });
      console.log('Added labels: ', labelNamesToAdd);
    } catch (error) {
      console.error('Request failed: ', error.request, error.message);
      tools.exit.failure('addLabelsToLabelable has been failed. ');
    }
  }

  if (labelNamesToRemove.size > 0) {
    try {
      await removeLabelsFromLabelable(tools, {
        labelIds: getLabelIds(allLabels, [...labelNamesToRemove] as LabelName[]),
        labelableId,
      });
      console.log('Removed labels: ', labelNamesToRemove);
    } catch (error) {
      console.error('Request failed: ', error.request, error.message);
      tools.exit.failure('removeLabelsFromLabelable has been failed. ');
    }
  }
})();
