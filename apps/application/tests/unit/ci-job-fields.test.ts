import { describe, expect, test } from 'vitest';
import { parse as parseYaml, parseAllDocuments } from 'yaml';
import {
  bitbucketCustomPipelines,
  bitbucketPipelineFields,
  githubDispatchFields,
  githubWorkflowName,
  gitlabVariableFields,
  jenkinsJobs,
  jenkinsParameterFields,
  missingRequiredFields,
  undeclaredNames,
} from '#shared/ci-job-fields';
import { resolveCiListingTarget } from '#shared/ci-actions';

describe('githubDispatchFields', () => {
  test('reads each input’s type, requirement, default, options and description', () => {
    const workflow = parseYaml(`
name: E2E
on:
  workflow_dispatch:
    inputs:
      args:
        description: Playwright arguments
        default: ''
      TARGET_ENV:
        type: choice
        required: true
        default: staging
        options: [staging, production]
      headed:
        type: boolean
        default: false
      shards:
        type: number
        default: 4
      deploy_to:
        type: environment
      label:
        required: true
`);
    expect(githubWorkflowName(workflow)).toBe('E2E');
    expect(githubDispatchFields(workflow)).toEqual([
      { name: 'args', type: 'string', required: false, default: '', description: 'Playwright arguments' },
      { name: 'TARGET_ENV', type: 'choice', required: true, default: 'staging', options: ['staging', 'production'] },
      { name: 'headed', type: 'boolean', required: false, default: 'false', options: ['true', 'false'] },
      { name: 'shards', type: 'number', required: false, default: '4' },
      { name: 'deploy_to', type: 'environment', required: false },
      { name: 'label', type: 'string', required: true },
    ]);
  });

  test('drops a choice’s default that is not one of its options, and a choice with none is text', () => {
    const workflow = parseYaml(`
on:
  workflow_dispatch:
    inputs:
      a: { type: choice, options: [x, y], default: z }
      b: { type: choice }
`);
    expect(githubDispatchFields(workflow)).toEqual([
      { name: 'a', type: 'choice', required: false, options: ['x', 'y'] },
      { name: 'b', type: 'string', required: false },
    ]);
  });

  test('is null without a workflow_dispatch trigger, empty with one that declares nothing', () => {
    expect(githubDispatchFields(parseYaml('on: push'))).toBeNull();
    expect(githubDispatchFields(parseYaml('on: [push, workflow_dispatch]'))).toEqual([]);
    expect(githubDispatchFields(parseYaml('on:\n  workflow_dispatch:\n'))).toEqual([]);
    expect(githubWorkflowName(parseYaml('on: push'))).toBeNull();
  });
});

describe('gitlabVariableFields', () => {
  test('reads the top-level variables, then each job’s, each name once', () => {
    const documents = parseAllDocuments(`
spec:
  inputs:
    stage: {}
---
variables:
  DEPLOY_ENV:
    value: staging
    options: [staging, production]
    description: Where to deploy
  RETRIES: 2
e2e:
  variables:
    PIWI_RERUN_ARGS: ""
    RETRIES: 5
  script: [npx @piwitests/reporter rerun]
stages: [test]
`).map((d) => d.toJS());
    expect(gitlabVariableFields(documents)).toEqual([
      {
        name: 'DEPLOY_ENV',
        type: 'choice',
        required: false,
        default: 'staging',
        description: 'Where to deploy',
        options: ['staging', 'production'],
      },
      { name: 'RETRIES', type: 'string', required: false, default: '2' },
      { name: 'PIWI_RERUN_ARGS', type: 'string', required: false, default: '', description: 'Set in the job e2e.' },
    ]);
  });
});

describe('Bitbucket custom pipelines', () => {
  const file = parseYaml(`
pipelines:
  default:
    - step: { script: [npm test] }
  custom:
    rerun:
      - variables:
          - name: PIWI_RERUN_ARGS
          - name: REGION
            default: eu-west-1
            allowed-values: [eu-west-1, us-east-1]
            description: Region under test
      - step: { script: [npx @piwitests/reporter rerun] }
    shared:
      import: shared-pipelines:main:e2e
`);

  test('lists the custom pipelines in their order', () => {
    expect(bitbucketCustomPipelines(file)).toEqual([
      { id: 'rerun', label: 'rerun' },
      { id: 'shared', label: 'shared' },
    ]);
    expect(bitbucketCustomPipelines(parseYaml('pipelines: { default: [] }'))).toEqual([]);
  });

  test('reads a pipeline’s variables, none for an imported one, null for one it does not have', () => {
    expect(bitbucketPipelineFields(file, 'rerun')).toEqual([
      { name: 'PIWI_RERUN_ARGS', type: 'string', required: false },
      {
        name: 'REGION',
        type: 'choice',
        required: false,
        default: 'eu-west-1',
        description: 'Region under test',
        options: ['eu-west-1', 'us-east-1'],
      },
    ]);
    expect(bitbucketPipelineFields(file, 'shared')).toEqual([]);
    expect(bitbucketPipelineFields(file, 'nightly')).toBeNull();
  });
});

describe('Jenkins', () => {
  test('lists jobs as paths: folders flattened, a multibranch pipeline by its branch, a disabled job left out', () => {
    expect(
      jenkinsJobs({
        jobs: [
          { _class: 'hudson.model.FreeStyleProject', name: 'smoke', buildable: true },
          { _class: 'hudson.model.FreeStyleProject', name: 'old', buildable: false },
          {
            _class: 'com.cloudbees.hudson.plugins.folder.Folder',
            name: 'qa',
            jobs: [
              { _class: 'org.jenkinsci.plugins.workflow.job.WorkflowJob', name: 'e2e', buildable: true },
              { _class: 'org.jenkinsci.plugins.workflow.multibranch.WorkflowMultiBranchProject', name: 'app' },
            ],
          },
        ],
      }),
    ).toEqual({
      jobs: [
        { id: 'smoke', label: 'smoke' },
        { id: 'qa/e2e', label: 'qa/e2e' },
        { id: 'qa/app/{branch}', label: 'qa/app/{branch}' },
      ],
      truncated: false,
    });
  });

  test('says when a folder lies deeper than the listing reads', () => {
    expect(jenkinsJobs({ jobs: [{ _class: 'com.cloudbees.hudson.plugins.folder.Folder', name: 'deep' }] })).toEqual({
      jobs: [],
      truncated: true,
    });
    expect(jenkinsJobs({ property: [] })).toBeNull();
  });

  test('reads parameters, with a boolean’s options and no password default', () => {
    expect(
      jenkinsParameterFields({
        property: [
          {},
          {
            parameterDefinitions: [
              { name: 'HEADED', type: 'BooleanParameterDefinition', defaultParameterValue: { value: true } },
              { name: 'NOTES', type: 'TextParameterDefinition', description: 'Free\ntext' },
              { name: 'TOKEN', type: 'PasswordParameterDefinition', defaultParameterValue: { value: 'secret' } },
              { name: 'RUN', type: 'RunParameterDefinition' },
            ],
          },
        ],
      }),
    ).toEqual([
      { name: 'HEADED', type: 'boolean', required: false, default: 'true', options: ['true', 'false'] },
      { name: 'NOTES', type: 'text', required: false, description: 'Free text' },
      { name: 'TOKEN', type: 'secret', required: false },
      { name: 'RUN', type: 'string', required: false },
    ]);
    expect(jenkinsParameterFields({ jobs: [] })).toBeNull();
  });
});

describe('what a dispatch sends against what the job declares', () => {
  const fields = githubDispatchFields(
    parseYaml(`
on:
  workflow_dispatch:
    inputs:
      args: {}
      env: { required: true }
      tier: { required: true, default: gold }
`),
  )!;

  test('names the required fields with no default that are not sent', () => {
    expect(missingRequiredFields(fields, ['args']).map((f) => f.name)).toEqual(['env']);
    expect(missingRequiredFields(fields, ['args', 'env'])).toEqual([]);
  });

  test('names what is sent but not declared', () => {
    expect(undeclaredNames(fields, ['args', 'SUITE'])).toEqual(['SUITE']);
  });
});

describe('resolveCiListingTarget', () => {
  test('takes a target whose job is not picked yet', () => {
    expect(resolveCiListingTarget({ type: 'github', ref: 'main', argsInput: '' })).toEqual({
      target: { type: 'github', ref: 'main', workflow: '' },
    });
    expect(resolveCiListingTarget({ type: 'bitbucket', credentialId: 4 })).toEqual({
      target: { type: 'bitbucket', pipeline: '', credentialId: 4 },
    });
    expect(
      resolveCiListingTarget({
        type: 'ci-server',
        preset: 'jenkins',
        baseUrl: 'https://ci.example.com',
        fields: { job: 'qa/e2e' },
      }),
    ).toEqual({
      target: { type: 'ci-server', preset: 'jenkins', baseUrl: 'https://ci.example.com/', job: 'qa/e2e', ref: '' },
    });
  });

  test('refuses what names nothing to read', () => {
    expect(resolveCiListingTarget({ type: 'gitlab', ref: ' ' })).toEqual({ error: expect.stringContaining('ref') });
    expect(resolveCiListingTarget({ type: 'ci-server', preset: 'custom' })).toEqual({
      error: 'A Custom request names no job to list.',
    });
    expect(resolveCiListingTarget({ type: 'ci-server', preset: 'jenkins', baseUrl: 'ftp://x' })).toEqual({
      error: expect.stringContaining('http(s)'),
    });
    expect(resolveCiListingTarget(null)).toEqual({ error: expect.any(String) });
  });
});
