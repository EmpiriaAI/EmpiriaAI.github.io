window.EMPIRIA_FEEDBACK_PIPELINE = {
  dataset: {
    sourceFile: 'all_passed.cleaned.jsonl',
    trajectoryCount: 11,
    toolCallCount: 1339,
    estimatedTokens: 945889,
    minToolCalls: 3,
    maxToolCalls: 462,
    minEstimatedTokens: 3076,
    maxEstimatedTokens: 253703,
    taskTypeDistribution: '5 feature development · 4 research analysis · 1 bug fixing · 1 debugging',
    outcomeDistribution: '2 successful · 9 incomplete',
    valueTierDistribution: '5 A · 2 B · 3 C · 1 search type A'
  },
  trajectories: {
    '14203f92-769e-42c1-b121-1fd0ea6dc86e': {
      clean: {
        trimmedTrailing: false,
        nonSystemMessages: 106,
        errorRate: 0.034,
        completeToolPairs: 59,
        estimatedTokens: 43246,
        dangerousHits: 0,
        passed: true,
        rejectReason: ''
      },
      classification: {
        isSafe: true,
        taskType: 'research_analysis',
        situation: 'successful',
        isSafeReasoning: '典型的UE5引擎源码研究：分析debug视图模式的shader编译与预编译机制，属于正常软件工程活动。',
        taskTypeReasoning: '用户询问纹理密度等debug视图模式的shader编译机制，agent通过大量代码检索与分析回答行为差异，属代码调研分析，无修改/修复意图。',
        situationReasoning: '轨迹以完整回答结束：agent明确结论“批量预编译是纹理密度模式独有的定制行为，shader本身所有debug mode共享”，并分三层展开解释，用户问题已得到解答。'
      },
      routing: {
        category: 'code',
        effectiveCategory: 'code',
        taskTypeSource: 'llm',
        valueTier: 'C',
        searchMainType: null,
        rescuedVia: null,
        votes: 'Code 59 · Search 0 · General 0',
        mainKept: 1,
        tieBroken: false,
        anyRescued: false
      },
      quality: {
        flag: 'keep',
        reasons: [],
        toolSteps: 59,
        errorRatio: 0.017,
        maxErrorChain: 1,
        maxNoProgress: 1,
        repeatRatio: 0,
        topRepeat: 1
      },
      difficulty: {
        flag: 'keep',
        reasons: [],
        userTurns: 0,
        distinctTaskCount: 0,
        toolCallsTotal: 59,
        longestLoopRatio: 0.119
      },
      segmentSummary: {
        outcomeConfirmed: 'success',
        segmentCount: 2,
        highQualityRatio: 0.1111111111111111,
        lowQualityRatio: 0,
        highNodes: 5,
        lowNodes: 0,
        totalNodes: 45
      },
      segments: [{
        nodes: [40, 41, 42, 43, 44],
        nodeSources: {
          40: [96, 97],
          41: [98, 99],
          42: [100, 101],
          43: [102, 103, 104],
          44: [105, 106]
        },
        label: 'high_quality',
        pattern: 'adaptive_strategy',
        reason: '在Material.cpp中搜索ShouldCache override无结果、搜索on-demand编译标志也无结果后，agent没有重复相同搜索，而是及时更换策略，并基于进一步的源码证据给出了完整结论。'
      }],
      thinkingClean: { category: 'code', withThinking: 41, dropped: 0, nearDuplicates: 0 }
    },
    'b14a7930-a254-47ff-af5c-8bbb6cd343e9': {
      clean: {
        trimmedTrailing: false,
        nonSystemMessages: 120,
        errorRate: 0.159,
        completeToolPairs: 63,
        estimatedTokens: 47081,
        dangerousHits: 0,
        passed: true,
        rejectReason: ''
      },
      classification: {
        isSafe: true,
        taskType: 'feature_development',
        situation: 'successful',
        isSafeReasoning: '常规前端开发任务：为Web应用构建官网落地页，涉及React组件、i18n、样式编写及Playwright截图验证，均为正常软件工程活动。',
        taskTypeReasoning: '核心意图是从0到1构建官网落地页：新建页面、组件、样式、i18n文案，并验证效果。截图验证和写文档仅为辅助步骤。',
        situationReasoning: '落地页已实现并通过截图验证，首屏、各板块和移动端均正常；agent明确完成并输出总结，停止开发服务器并写好设计文档，流程完整收尾。'
      },
      routing: {
        category: 'code',
        effectiveCategory: 'code',
        taskTypeSource: 'llm',
        valueTier: 'A',
        searchMainType: null,
        rescuedVia: null,
        votes: 'Code 60 · Search 0 · General 0',
        mainKept: 1,
        tieBroken: false,
        anyRescued: false
      },
      quality: {
        flag: 'keep',
        reasons: [],
        toolSteps: 63,
        errorRatio: 0.111,
        maxErrorChain: 3,
        maxNoProgress: 1,
        repeatRatio: 0,
        topRepeat: 1
      },
      difficulty: {
        flag: 'keep',
        reasons: [],
        userTurns: 0,
        distinctTaskCount: 0,
        toolCallsTotal: 63,
        longestLoopRatio: 0.286
      },
      segmentSummary: {
        outcomeConfirmed: 'success',
        segmentCount: 2,
        highQualityRatio: 0.11764705882352941,
        lowQualityRatio: 0,
        highNodes: 6,
        lowNodes: 0,
        totalNodes: 51
      },
      segments: [
        {
          nodes: [40, 41, 42],
          nodeSources: { 40: [92, 93], 41: [94, 95], 42: [96, 97] },
          label: 'high_quality',
          pattern: 'error_recovery',
          reason: 'playwright-core加载失败后，agent定位到另一份完整安装并切换模块路径，成功恢复截图流程。'
        },
        {
          nodes: [43, 44, 45],
          nodeSources: { 43: [98, 99], 44: [100, 101], 45: [102, 103] },
          label: 'high_quality',
          pattern: 'adaptive_strategy',
          reason: 'Playwright找不到内置Chromium后，agent检查本机浏览器并改用系统Chrome，最终成功生成桌面端和移动端截图。'
        }
      ],
      thinkingClean: { category: 'code', withThinking: 46, dropped: 0, nearDuplicates: 0 }
    }
  }
};
