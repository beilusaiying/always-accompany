import { axis47 } from '../p1/p1_node4_axis47.mjs';
import { loadATFull } from '../p1/p1_axis.mjs';
import fs from 'fs';

async function run() {
    console.log("Loading AT Full...");
    loadATFull('chat'); // 触发懒加载
    console.log("AT Full loaded.");

    const testWords = ['仿生学', '声波', '熵增', '复利', '反脆弱', '心流', '路径依赖', '幸存者偏差', '开心', '悲伤', '雷达', '蝙蝠'];
    const inputWordSet = new Set(testWords);
    const wordProfiles = []; // 空 profile 模拟新词

    console.log("Running axis47...");
    const result = axis47(testWords, 'chat', inputWordSet, wordProfiles);

    const wordToAxes = {};
    for (const w of testWords) {
        wordToAxes[w] = [];
    }

    // 倒排遍历
    for (const [subAxis, wordSet] of Object.entries(result.witnesses)) {
        for (const w of wordSet) {
            if (wordToAxes[w]) {
                wordToAxes[w].push(subAxis);
            }
        }
    }

    let output = "## axis47 新词坐标覆盖实测 (无 wordProfiles)\n\n";
    output += "测试词总数: " + testWords.length + "\n\n";
    output += "| 词语 | 命中子轴数量 | 命中的子轴列表 |\n";
    output += "|---|---|---|\n";

    let emptyCount = 0;
    for (const w of testWords) {
        const axes = wordToAxes[w];
        if (axes.length === 0) {
            emptyCount++;
        }
        output += `| ${w} | ${axes.length} | ${axes.join(', ')} |\n`;
    }

    output += `\n**坐标为空的词数**: ${emptyCount} / ${testWords.length}\n`;

    const outPath = 'D:\\project\\beilu-与你之诗\\beilu的工作日志和项目日志\\前端计划\\new自驱动p1发散工程文件\\md\\B5_axis47新词坐标覆盖实测_20260615.md';
    fs.writeFileSync(outPath, output, 'utf-8');
    console.log("Done. Written to " + outPath);
}

run().catch(console.error);