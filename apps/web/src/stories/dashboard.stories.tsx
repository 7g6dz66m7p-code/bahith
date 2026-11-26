import type { Meta, StoryObj } from '@storybook/nextjs-vite';

import { ActivityCard } from '@/components/dashboard/activity-card';
import { BrandLockup } from '@/components/dashboard/brand-mark';
import {
  AssistantCard,
  ProjectsCard,
  SanadCard,
  SourcesShelf,
  StatsCard,
  ToolTiles,
  WorkflowCard,
} from '@/components/dashboard/panels';

import { emptyOverview, fixtureOverview, fixtureProgress, fixtureTarget } from './fixtures';

/** The real dashboard panels with Storybook fixtures (see fixtures.ts). */
const meta: Meta = { title: 'Liquid Glass/Dashboard', tags: ['visual'] };
export default meta;

export const Brand: StoryObj = { render: () => <BrandLockup /> };

export const Tools: StoryObj = { render: () => <ToolTiles latest={fixtureTarget} /> };

export const ToolsWithoutProject: StoryObj = { render: () => <ToolTiles latest={null} /> };

export const Overview: StoryObj = {
  render: () => (
    <div className="grid gap-5 xl:grid-cols-3">
      <StatsCard overview={fixtureOverview} />
      <ProjectsCard progress={fixtureProgress} />
      <WorkflowCard project={fixtureProgress[0] ?? null} />
    </div>
  ),
};

export const EmptyAccount: StoryObj = {
  render: () => (
    <div className="grid gap-5 xl:grid-cols-3">
      <StatsCard overview={emptyOverview} />
      <ProjectsCard progress={[]} />
      <WorkflowCard project={null} />
    </div>
  ),
};

export const SanadAndShelf: StoryObj = {
  render: () => (
    <div className="grid gap-5 xl:grid-cols-3">
      <SourcesShelf sources={fixtureOverview.recentSources} />
      <SanadCard latest={fixtureTarget} />
      <AssistantCard latest={fixtureTarget} />
    </div>
  ),
};

export const Activity: StoryObj = {
  render: () => (
    <div className="max-w-xl">
      <ActivityCard overview={fixtureOverview} />
    </div>
  ),
};
