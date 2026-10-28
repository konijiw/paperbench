using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

internal static partial class MinerULibraryReview
{
    private static string PromptPresetsDirectory { get { return Path.Combine(AppDirectory, "prompts"); } }
    private static string PromptPresetsMarker { get { return Path.Combine(PromptPresetsDirectory, ".initialized"); } }

    private sealed class PaperPromptPreset
    {
        public string id { get; set; }
        public string title { get; set; }
        public string prompt { get; set; }
        public long order { get; set; }
        public bool deleted { get; set; }
        public string updatedAt { get; set; }
    }

    private sealed class LegacyPaperPromptPresetStore
    {
        public List<PaperPromptPreset> items { get; set; }
    }

    private sealed class PaperPromptPresetRequest
    {
        public List<PaperPromptPreset> items { get; set; }
        public string id { get; set; }
        public string title { get; set; }
        public string prompt { get; set; }
        public string revision { get; set; }
        public bool deleted { get; set; }
    }

    private static bool IsPromptPresetId(string id)
    {
        return id != null && Regex.IsMatch(id, "^[A-Za-z0-9_-]{1,80}$");
    }

    private static string PromptPresetPath(string id)
    {
        if (!IsPromptPresetId(id)) throw new InvalidOperationException("预设标识无效。");
        return Path.Combine(PromptPresetsDirectory, id + ".json");
    }

    private static string[] PromptPresetFiles()
    {
        if (!Directory.Exists(PromptPresetsDirectory)) return new string[0];
        // Syncthing conflict copies are preserved on disk, not shown as duplicate presets.
        return Directory.GetFiles(PromptPresetsDirectory, "*.json")
            .Where(path => IsPromptPresetId(Path.GetFileNameWithoutExtension(path))).ToArray();
    }

    private static PaperPromptPreset ReadPromptPreset(string path, string content)
    {
        PaperPromptPreset item;
        try { item = Json.Deserialize<PaperPromptPreset>(content); }
        catch { throw new InvalidOperationException("无法读取预设文件：" + Path.GetFileName(path) + "。请等待同步完成后重试。"); }
        if (item == null || item.id != Path.GetFileNameWithoutExtension(path) ||
            (!item.deleted && (String.IsNullOrWhiteSpace(item.title) || String.IsNullOrWhiteSpace(item.prompt))))
            throw new InvalidOperationException("预设文件内容无效：" + Path.GetFileName(path));
        return item;
    }

    private static string PromptPresetRevision(string content)
    {
        using (SHA256 hash = SHA256.Create())
            return BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(content))).Replace("-", "").ToLowerInvariant();
    }

    private static void ValidatePromptPreset(string title, string prompt)
    {
        if (String.IsNullOrWhiteSpace(title) || String.IsNullOrWhiteSpace(prompt))
            throw new InvalidOperationException("名称和提示词都不能为空。");
        if (title.Length > 32 || prompt.Length > 4000)
            throw new InvalidOperationException("名称最多 32 字，提示词最多 4000 字。");
    }

    private static void WriteInitialPromptPresets(List<PaperPromptPreset> items)
    {
        if (items == null || items.Count > 100) throw new InvalidOperationException("预设列表无效，最多保存 100 条。");
        var ids = new HashSet<string>(StringComparer.Ordinal);
        foreach (PaperPromptPreset item in items)
        {
            if (item == null || !IsPromptPresetId(item.id) || !ids.Add(item.id))
                throw new InvalidOperationException("预设标识无效或重复。");
            ValidatePromptPreset(item.title, item.prompt);
        }
        Directory.CreateDirectory(PromptPresetsDirectory);
        for (int index = 0; index < items.Count; index++)
        {
            PaperPromptPreset item = items[index];
            AtomicWrite(PromptPresetPath(item.id), Json.Serialize(new PaperPromptPreset
            {
                id = item.id, title = item.title, prompt = item.prompt, order = index,
                updatedAt = DateTime.UtcNow.ToString("o")
            }));
        }
        AtomicWrite(PromptPresetsMarker, "1");
    }

    private static void EnsurePromptPresetsMigrated()
    {
        if (File.Exists(PromptPresetsMarker)) return;
        // Any synchronized record, including a deletion, takes precedence over local legacy settings.
        if (PromptPresetFiles().Length > 0)
        {
            AtomicWrite(PromptPresetsMarker, "1");
            return;
        }
        string legacy;
        if (!AiPreferences.TryGetValue("paperPromptPresets", out legacy) || String.IsNullOrWhiteSpace(legacy)) return;
        List<PaperPromptPreset> items;
        try
        {
            items = legacy.TrimStart().StartsWith("[", StringComparison.Ordinal)
                ? Json.Deserialize<List<PaperPromptPreset>>(legacy)
                : Json.Deserialize<LegacyPaperPromptPresetStore>(legacy).items;
        }
        catch { throw new InvalidOperationException("旧预设无法读取，已保留原数据。请检查本机 settings.json。"); }
        WriteInitialPromptPresets(items);
        AiPreferences.Remove("paperPromptPresets");
        SaveSettings();
    }

    private static object ReadPaperPromptPresetsResponse()
    {
        var rows = new List<Dictionary<string, object>>();
        foreach (string path in PromptPresetFiles())
        {
            string content = File.ReadAllText(path, Encoding.UTF8);
            PaperPromptPreset item = ReadPromptPreset(path, content);
            if (item.deleted) continue;
            rows.Add(new Dictionary<string, object>
            {
                { "id", item.id }, { "title", item.title }, { "prompt", item.prompt },
                { "order", item.order }, { "revision", PromptPresetRevision(content) }
            });
        }
        int conflicts = Directory.Exists(PromptPresetsDirectory)
            ? Directory.GetFiles(PromptPresetsDirectory, "*.sync-conflict-*.json").Length : 0;
        return new
        {
            initialized = File.Exists(PromptPresetsMarker),
            items = rows.OrderBy(row => Convert.ToInt64(row["order"]))
                .ThenBy(row => Convert.ToString(row["id"]), StringComparer.Ordinal).ToArray(),
            conflicts = conflicts
        };
    }

    private static object GetPaperPromptPresets()
    {
        lock (StateLock)
        {
            EnsurePromptPresetsMigrated();
            return ReadPaperPromptPresetsResponse();
        }
    }

    private static void InitializePaperPromptPresets(Stream stream, string body)
    {
        PaperPromptPresetRequest request = Json.Deserialize<PaperPromptPresetRequest>(body);
        lock (StateLock)
        {
            EnsurePromptPresetsMigrated();
            if (!File.Exists(PromptPresetsMarker)) WriteInitialPromptPresets(request == null ? null : request.items);
            WriteJson(stream, ReadPaperPromptPresetsResponse());
        }
    }

    private static void SavePaperPromptPreset(Stream stream, string body)
    {
        PaperPromptPresetRequest request = Json.Deserialize<PaperPromptPresetRequest>(body);
        if (request == null) throw new InvalidOperationException("预设内容无效。");
        lock (StateLock)
        {
            EnsurePromptPresetsMigrated();
            if (!File.Exists(PromptPresetsMarker)) throw new InvalidOperationException("预设尚未载入，请重新打开预设菜单。");
            string id = String.IsNullOrEmpty(request.id) ? Guid.NewGuid().ToString("N") : request.id;
            string path = PromptPresetPath(id);
            string content = File.Exists(path) ? File.ReadAllText(path, Encoding.UTF8) : null;
            if (!String.Equals(content == null ? "" : PromptPresetRevision(content), request.revision ?? "", StringComparison.Ordinal))
                throw new InvalidOperationException("这条预设已在另一处修改，当前草稿已保留。请复制需要保留的内容，取消编辑并重新打开后再修改。");
            PaperPromptPreset previous = content == null ? null : ReadPromptPreset(path, content);
            if (previous != null && previous.deleted) throw new InvalidOperationException("这条预设已被删除。当前草稿已保留，可复制后新建预设。");
            if (!request.deleted) ValidatePromptPreset(request.title, request.prompt);
            long order = previous == null ? 0 : previous.order;
            if (previous == null)
            {
                if (request.deleted) throw new InvalidOperationException("预设不存在。");
                var active = new List<PaperPromptPreset>();
                foreach (string existingPath in PromptPresetFiles())
                {
                    PaperPromptPreset item = ReadPromptPreset(existingPath, File.ReadAllText(existingPath, Encoding.UTF8));
                    if (!item.deleted) active.Add(item);
                }
                if (active.Count >= 100) throw new InvalidOperationException("最多保存 100 条预设。");
                order = active.Count == 0 ? 0 : active.Max(item => item.order) + 1;
            }
            AtomicWrite(path, Json.Serialize(new PaperPromptPreset
            {
                id = id, title = request.deleted ? null : request.title.Trim(),
                prompt = request.deleted ? null : request.prompt.Trim(), order = order,
                deleted = request.deleted, updatedAt = DateTime.UtcNow.ToString("o")
            }));
            WriteJson(stream, ReadPaperPromptPresetsResponse());
        }
    }
}
