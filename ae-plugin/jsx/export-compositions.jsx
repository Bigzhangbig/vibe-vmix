#include "../vendor/json2.jsx"
/* Run in Adobe After Effects via File > Scripts > Run Script File.
 * Read-only for the project; writes JSON only to the chosen location.
 */
(function () {
    try {
        var project = app.project;
        if (!project || !project.file) throw new Error("请先打开并保存要导入的 AE 工程。");
        var selected = project.selection || [], comps = [], i, item, usedSelection = false;
        function add(comp) {
            var name = String(comp.name);
            if (!name || name.length > 200 || /[\x00-\x1f\x7f]/.test(name))
                throw new Error("合成名称过长或含控制字符，请改名后再导出。");
            comps.push({
                name: name,
                width: comp.width,
                height: comp.height,
                fps: comp.frameRate,
                duration: comp.duration
            });
            if (comps.length > 256)
                throw new Error("一次最多导出 256 个合成。请在项目面板选择要导出的合成。");
        }
        for (i = 0; i < selected.length; i++) {
            item = selected[i];
            if (item instanceof CompItem) { add(item); usedSelection = true; }
        }
        if (!usedSelection) {
            for (i = 1; i <= project.numItems; i++) {
                item = project.item(i);
                if (item instanceof CompItem) add(item);
            }
        }
        if (!comps.length) throw new Error("当前工程没有合成。");
        var file = File.saveDialog("保存合成清单（建议命名：vibe-vmix-ae.json）");
        if (!file) return;
        if (!/\.json$/i.test(file.name)) {
            file = new File(file.fsName + ".json");
            if (file.exists && !confirm("此 JSON 已存在，是否覆盖？")) return;
        }
        file.encoding = "UTF-8";
        if (!file.open("w")) throw new Error("无法写入文件。请在 AE 首选项中允许脚本写入文件。");
        try {
            if (!file.write(JSON.stringify({
                kind: "vibe-vmix-ae",
                version: 1,
                project: File.decode(project.file.name),
                compositions: comps
            }, null, 2) + "\n")) throw new Error("写入合成清单失败。");
        } finally {
            file.close();
        }
        alert("已导出 " + comps.length + " 个合成。请在舞台模块为原 AE 工程导入此 JSON。");
    } catch (error) {
        alert("合成清单未导出：" + error.message);
    }
})();
