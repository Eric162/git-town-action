import * as core from '@actions/core'
import * as github from '@actions/github'
import { DirectedGraph } from 'graphology'
import { bfsFromNode, dfsFromNode } from 'graphology-traversal'
import { topologicalSort } from 'graphology-dag'
import type { PullRequest, Context, StackNodeAttributes } from './types'
import { remark } from './remark'

export async function main({
  octokit,
  currentPullRequest,
  pullRequests,
  mainBranch,
  perennialBranches,
  skipSingleStacks,
}: Context) {
  const repoGraph = new DirectedGraph<StackNodeAttributes>()

  repoGraph.mergeNode(mainBranch, {
    type: 'perennial',
    ref: mainBranch,
  })

  perennialBranches.forEach((perennialBranch) => {
    repoGraph.mergeNode(perennialBranch, {
      type: 'perennial',
      ref: perennialBranch,
    })
  })

  const openPullRequests = pullRequests.filter(
    (pullRequest) => pullRequest.state === 'open'
  )

  openPullRequests.forEach((openPullRequest) => {
    repoGraph.mergeNode(openPullRequest.head.ref, {
      type: 'pull-request',
      ...openPullRequest,
    })
  })

  openPullRequests.forEach((openPullRequest) => {
    const hasExistingBase = repoGraph.hasNode(openPullRequest.base.ref)
    if (hasExistingBase) {
      repoGraph.mergeDirectedEdge(openPullRequest.base.ref, openPullRequest.head.ref)

      return
    }

    const basePullRequest = pullRequests.find(
      (basePullRequest) => basePullRequest.head.ref === openPullRequest.base.ref
    )
    if (basePullRequest?.state === 'closed') {
      repoGraph.mergeNode(openPullRequest.base.ref, {
        type: 'pull-request',
        ...basePullRequest,
      })
      repoGraph.mergeDirectedEdge(openPullRequest.base.ref, openPullRequest.head.ref)

      return
    }

    repoGraph.mergeNode(openPullRequest.base.ref, {
      type: 'orphan-branch',
      ref: openPullRequest.base.ref,
    })
    repoGraph.mergeDirectedEdge(openPullRequest.base.ref, openPullRequest.head.ref)
  })

  const terminatingRefs = [mainBranch, ...perennialBranches]

  const getStackGraph = (pullRequest: PullRequest) => {
    const stackGraph = repoGraph.copy() as DirectedGraph<StackNodeAttributes>
    stackGraph.setNodeAttribute(pullRequest.head.ref, 'isCurrent', true)

    bfsFromNode(
      stackGraph,
      pullRequest.head.ref,
      (ref, attributes) => {
        stackGraph.setNodeAttribute(ref, 'shouldPrint', true)
        return attributes.type === 'perennial' || attributes.type === 'orphan-branch'
      },
      { mode: 'inbound' }
    )

    dfsFromNode(
      stackGraph,
      pullRequest.head.ref,
      (ref) => {
        stackGraph.setNodeAttribute(ref, 'shouldPrint', true)
      },
      { mode: 'outbound' }
    )

    stackGraph.forEachNode((ref, stackNode) => {
      if (!stackNode.shouldPrint) {
        stackGraph.dropNode(ref)
      }
    })

    return stackGraph
  }

  const getOutput = (graph: DirectedGraph<StackNodeAttributes>) => {
    const lines: string[] = []

    // `dfs` is bugged and doesn't traverse in topological order.
    // `dfsFromNode` does, so we'll do the topological sort ourselves
    // start traversal from the root.
    const rootRef = topologicalSort(graph)[0]

    dfsFromNode(
      graph,
      rootRef,
      (_, stackNode, depth) => {
        if (!stackNode.shouldPrint) return

        const tabSize = depth * 2
        const indentation = new Array(tabSize).fill(' ').join('')

        let line = indentation

        if (stackNode.type === 'orphan-branch') {
          line += `- \`${stackNode.ref}\` - :warning: No PR associated with branch`
        }

        if (stackNode.type === 'perennial' && terminatingRefs.includes(stackNode.ref)) {
          line += `- \`${stackNode.ref}\``
        }

        if (stackNode.type === 'pull-request') {
          line += `- #${stackNode.number}`
        }

        if (stackNode.isCurrent) {
          line += ' :point_left:'
        }

        lines.push(line)
      },
      { mode: 'directed' }
    )

    return lines.join('\n')
  }

  const stackGraph = getStackGraph(currentPullRequest)

  const shouldSkip = () => {
    const neighbors = stackGraph.neighbors(currentPullRequest.head.ref)
    const allPerennialBranches = stackGraph.filterNodes(
      (_, nodeAttributes) => nodeAttributes.type === 'perennial'
    )

    return (
      skipSingleStacks &&
      neighbors.length === 1 &&
      allPerennialBranches.includes(neighbors.at(0) || '')
    )
  }

  if (shouldSkip()) {
    return
  }

  const jobs: Array<() => Promise<void>> = []

  stackGraph.forEachNode((_, stackNode) => {
    if (stackNode.type !== 'pull-request' || !stackNode.shouldPrint) {
      return
    }

    jobs.push(async () => {
      core.info(`Updating stack details for PR #${stackNode.number}`)

      const stackGraph = getStackGraph(stackNode)
      const output = getOutput(stackGraph)

      let description = stackNode.body ?? ''
      description = updateDescription({
        description,
        output,
      })

      await octokit.rest.pulls.update({
        ...github.context.repo,
        pull_number: stackNode.number,
        body: description,
      })
    })
  })

  await Promise.allSettled(jobs.map((job) => job()))
}

const ANCHOR = '<!-- branch-stack -->'
const ANCHOR_REGION_START = '<!-- branch-stack-region-start -->'
const ANCHOR_REGION_END = '<!-- branch-stack-region-end -->'

export function updateDescription({
  description,
  output,
}: {
  description: string
  output: string
}) {
  const descriptionAst = remark.parse(description)

  let usingAnchorRegion = false
  let anchorIndex = descriptionAst.children.findIndex(
    (node) => node.type === 'html' && node.value === ANCHOR
  )

  if (anchorIndex === -1) {
    anchorIndex = descriptionAst.children.findIndex(
      (node) => node.type === 'html' && node.value === ANCHOR_REGION_START
    )

    usingAnchorRegion = anchorIndex !== -1
  }

  // if the anchor is the last ast node, set nearestListIndex to anchorIndex for proper splicing
  let spliceEndIndex =
    anchorIndex === descriptionAst.children.length - 1 ? anchorIndex : anchorIndex + 1

  if (usingAnchorRegion) {
    const endAnchorIndex = descriptionAst.children.findIndex(
      (node) => node.type === 'html' && node.value === ANCHOR_REGION_END
    )

    spliceEndIndex = endAnchorIndex === -1 ? anchorIndex : endAnchorIndex
  }

  const isMissingAnchor = anchorIndex === -1
  const outputAst =
    usingAnchorRegion || isMissingAnchor ?
      remark.parse(`${ANCHOR_REGION_START}\n${output}\n${ANCHOR_REGION_END}`)
    : remark.parse(`${ANCHOR}\n${output}`)

  if (isMissingAnchor) {
    descriptionAst.children.push(...outputAst.children)

    return remark.stringify(descriptionAst)
  }

  // NOTE: when not using the region syntax, this will eat up any list node in direct succession to the anchor comment.
  if (!usingAnchorRegion && descriptionAst.children[spliceEndIndex]?.type !== 'list') {
    spliceEndIndex = anchorIndex
  }

  descriptionAst.children.splice(
    anchorIndex,
    spliceEndIndex - anchorIndex + 1,
    ...outputAst.children
  )

  return remark.stringify(descriptionAst)
}
