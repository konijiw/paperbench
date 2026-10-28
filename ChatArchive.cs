using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

internal static partial class MinerULibraryReview
{
    private static MaterialChatArchive CreateChatArchive(Dictionary<string, string> bindings)
    {
        try
        {
            CodexBridge bridge = GetCodex();
            bridge.ConnectInfo();
            return new MaterialChatArchive(bridge.ReadHistory, bindings, null);
        }
        catch (Exception ex) { return new MaterialChatArchive(null, bindings, "无法读取 Codex 历史：" + ex.Message); }
    }

    private sealed class MaterialChatArchive
    {
        private readonly Func<string, object, object> rpc;
        private readonly Dictionary<string, string> bindings;
        private readonly string connectionError;
        public MaterialChatArchive(Func<string, object, object> reader, Dictionary<string, string> links, string error)
        { rpc = reader; bindings = links ?? new Dictionary<string, string>(); connectionError = error; }
        private static Dictionary<string, object> Map(object value) { return value as Dictionary<string, object> ?? new Dictionary<string, object>(); }
        private static object Get(object value, string key) { object result; return Map(value).TryGetValue(key, out result) ? result : null; }
        private static string Text(object value, string key) { object item = Get(value, key); return item as string ?? (item == null ? "" : Convert.ToString(item, System.Globalization.CultureInfo.InvariantCulture)); }
        private static IEnumerable<object> Rows(object value)
        { return value is IEnumerable && !(value is string) && !(value is IDictionary) ? ((IEnumerable)value).Cast<object>() : Enumerable.Empty<object>(); }
        private static bool SameDirectory(string left, string right)
        {
            try { return !String.IsNullOrWhiteSpace(left) && String.Equals(Path.GetFullPath(left).TrimEnd('\\', '/'), Path.GetFullPath(right).TrimEnd('\\', '/'), StringComparison.OrdinalIgnoreCase); }
            catch { return false; }
        }
        private static string Time(object value)
        {
            if (value == null) return "未提供时间";
            long seconds;
            if (Int64.TryParse(Convert.ToString(value), out seconds))
            {
                try { return new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc).AddMilliseconds(seconds > 100000000000 ? seconds : seconds * 1000).ToString("yyyy-MM-dd HH:mm:ss 'UTC'"); } catch { }
            }
            return Convert.ToString(value);
        }
        private static bool Unsupported(Exception error)
        { string text = error.Message.ToLowerInvariant(); return text.Contains("-32601") || text.Contains("method not found") || text.Contains("unknown method") || text.Contains("unsupported method"); }

        private Dictionary<string, Dictionary<string, object>> FindThreads(MaterialSource paper, Action<string> warn)
        {
            var found = new Dictionary<string, Dictionary<string, object>>(StringComparer.Ordinal);
            string bound;
            if (bindings.TryGetValue("0:" + ReviewKey(paper.directory), out bound) && !String.IsNullOrWhiteSpace(bound))
                found[bound] = new Dictionary<string, object> { { "id", bound }, { "bound", true } };
            foreach (bool archived in new[] { false, true })
            {
                string cursor = null; var visited = new HashSet<string>();
                try
                {
                    for (int page = 0; page < 200; page++)
                    {
                        var args = new Dictionary<string, object> { { "cwd", paper.directory }, { "archived", archived }, { "limit", 100 }, { "sortKey", "created_at" }, { "sortDirection", "asc" },
                            { "sourceKinds", new[] { "cli", "vscode", "appServer", "exec", "unknown" } }, { "useStateDbOnly", true } };
                        if (cursor != null) args["cursor"] = cursor;
                        object result = rpc("thread/list", args);
                        foreach (object row in Rows(Get(result, "data")))
                        {
                            string id = Text(row, "id");
                            // Do not trust the list filter alone; scope every discovered thread to this exact paper.
                            if (id.Length > 0 && SameDirectory(Text(row, "cwd"), paper.directory)) found[id] = Map(row);
                        }
                        cursor = Text(result, "nextCursor");
                        if (cursor.Length == 0) break;
                        if (!visited.Add(cursor) || page == 199) { warn("对话列表分页未结束，已导出找到的对话，请核对是否遗漏。"); break; }
                    }
                }
                catch (Exception ex) { warn((archived ? "已归档" : "普通") + "对话列表读取失败；已保存的关联仍会尝试导出：" + ex.Message); }
            }
            return found;
        }

        private List<object> ReadTurns(string id, Action<string> warn)
        {
            var turns = new List<object>(); var seenTurns = new HashSet<string>(); var visited = new HashSet<string>(); string cursor = null;
            try
            {
                for (int page = 0; page < 1000; page++)
                {
                    var args = new Dictionary<string, object> { { "threadId", id }, { "limit", 50 }, { "itemsView", "full" }, { "sortDirection", "asc" } };
                    if (cursor != null) args["cursor"] = cursor;
                    object result = rpc("thread/turns/list", args);
                    foreach (object turn in Rows(Get(result, "data")))
                    {
                        string turnId = Text(turn, "id");
                        if (turnId.Length == 0 || seenTurns.Add(turnId)) turns.Add(turn);
                    }
                    cursor = Text(result, "nextCursor");
                    if (cursor.Length == 0) break;
                    if (!visited.Add(cursor) || page == 999) { warn("历史分页未结束，本对话档案可能不完整。"); break; }
                }
            }
            catch (Exception ex)
            {
                if (turns.Count == 0 && Unsupported(ex))
                {
                    // Older CLI releases return complete legacy history through thread/read.
                    object legacy = rpc("thread/read", new Dictionary<string, object> { { "threadId", id }, { "includeTurns", true } });
                    object rawTurns = Get(Get(legacy, "thread"), "turns");
                    if (rawTurns == null) throw new InvalidDataException("此 Codex 版本没有返回完整历史。");
                    return Rows(rawTurns).ToList();
                }
                if (turns.Count == 0) throw;
                warn("部分历史读取失败，已保留读取到的内容：" + ex.Message);
            }
            return turns;
        }

        public int Export(MaterialSource paper, string target, Action<string> warning)
        {
            string folder = Path.Combine(target, "AI对话"); Directory.CreateDirectory(folder);
            var index = new StringBuilder("# " + MaterialMd(paper.title) + " · AI 对话档案\n\n这是已有对话的可读快照，不是论文原文或会话迁移文件。工具执行日志和内部推理不包含在档案中。\n\n");
            int exported = 0;
            if (connectionError != null)
            {
                warning(connectionError); index.Append("未能连接本机 Codex 历史；其他论文资料仍已导出。\n");
            }
            else
            {
                var threads = FindThreads(paper, warning);
                var images = new ChatArchiveImages(folder, paper.directory, warning);
                int number = 0;
                foreach (var entry in threads.OrderBy(x => Text(x.Value, "createdAt"), StringComparer.Ordinal).ThenBy(x => x.Key, StringComparer.Ordinal))
                {
                    string file = "C" + (++number).ToString("D3") + ".md";
                    string title = ""; var problems = new List<string>();
                    Action<string> warn = delegate(string text) { problems.Add(text); warning("对话 " + file + "：" + text); };
                    try
                    {
                        object thread = Get(rpc("thread/read", new Dictionary<string, object> { { "threadId", entry.Key } }), "thread");
                        if (thread == null) throw new InvalidDataException("没有返回对话信息。");
                        string cwd = Text(thread, "cwd");
                        bool isBound = Get(entry.Value, "bound") is bool && (bool)Get(entry.Value, "bound");
                        if (!SameDirectory(cwd, paper.directory) && !(isBound && cwd.Length == 0))
                            throw new InvalidDataException("对话工作目录与所选论文不一致，未导出该对话。");
                        title = Text(thread, "name"); if (title.Length == 0) title = Text(thread, "preview");
                        if (title.Length == 0) title = "未命名对话"; if (title.Length > 180) title = title.Substring(0, 180);
                        var text = new StringBuilder("# " + MaterialMd(title.Replace("\n", " ")) + "\n\n论文：" + MaterialMd(paper.title) + "\n\n对话 ID：`" + MaterialMd(entry.Key) + "`\n\n创建时间：" + Time(Get(thread, "createdAt")) + "\n\n最后更新时间：" + Time(Get(thread, "updatedAt")) + "\n\n");
                        string state = Text(Get(thread, "status"), "type");
                        if (state == "active" || state == "inProgress") warn("该对话正在进行，本次只包含读取时已有的内容。");
                        int messages = 0, turnNumber = 0;
                        foreach (object turn in ReadTurns(entry.Key, warn))
                        {
                            int inTurn = 0; var body = new StringBuilder();
                            foreach (object item in Rows(Get(turn, "items")))
                            {
                                string type = Text(item, "type"), message = "";
                                if (type == "userMessage") message = UserMessage(item, images);
                                else if (type == "agentMessage") message = images.Rewrite(Text(item, "text"));
                                else if (type == "imageGeneration") message = images.Image(Text(item, "result"), "AI 生成图片");
                                else continue;
                                if (String.IsNullOrWhiteSpace(message)) continue;
                                body.Append("### ").Append(type == "userMessage" ? "用户" : type == "agentMessage" && Text(item, "phase") == "commentary" ? "AI（过程说明）" : "AI").Append("\n\n").Append(message).Append("\n\n");
                                inTurn++;
                            }
                            if (inTurn > 0) text.Append("## 回合 ").Append(++turnNumber).Append("\n\n").Append(body).Append("---\n\n");
                            messages += inTurn;
                            if (Text(turn, "status") == "inProgress") warn("有尚未完成的回复，本次档案可能不是最终回答。");
                            if (text.Length > 20000000) { warn("对话内容较大，本次保留前 2000 万字符附近的完整回合。"); break; }
                        }
                        if (messages == 0) { text.Append("没有可导出的用户提问或 AI 回复。\n"); warn("未读到可用消息；对话可能为空或历史已不在本机。"); }
                        if (problems.Count > 0) text.Append("\n## 档案说明\n\n").Append(String.Join("\n", problems.Select(x => "- " + MaterialMd(x)).ToArray())).Append("\n");
                        MaterialWrite(folder, file, text.ToString()); if (messages > 0) exported++;
                        index.Append("- [").Append(MaterialMd(title.Replace("\n", " "))).Append("](").Append(file).Append(") · ").Append(messages).Append(" 条消息").Append(problems.Count > 0 ? " · 请查看档案说明" : "").Append("\n");
                    }
                    catch (Exception ex)
                    {
                        warn("读取失败：" + ex.Message);
                        index.Append("- 对话 `").Append(MaterialMd(entry.Key)).Append("` 未能导出：").Append(MaterialMd(ex.Message)).Append("\n");
                    }
                }
                if (threads.Count == 0) index.Append("没有找到此论文的关联对话。移动过论文目录、换电脑或删除本机历史后，可能无法找到原对话。\n");
            }
            MaterialWrite(folder, "索引.md", index.ToString()); return exported;
        }

        private static string UserMessage(object item, ChatArchiveImages images)
        {
            object content = Get(item, "content"); if (content is string) return images.Rewrite((string)content);
            var text = new StringBuilder();
            foreach (object part in Rows(content))
            {
                string type = Text(part, "type");
                if (type == "text" || type == "inputText" || type == "input_text") text.Append(images.Rewrite(Text(part, "text")));
                else if (type == "image" || type == "input_image") text.Append(images.Image(Text(part, "url").Length > 0 ? Text(part, "url") : Text(part, "image_url"), "用户图片"));
                else if (type == "localImage") text.Append(images.Image(Text(part, "path"), "用户图片"));
                else if (type == "mention") text.Append("@").Append(MaterialMd(Text(part, "name")));
                else if (type == "skill") text.Append("[使用技能：").Append(MaterialMd(Text(part, "name"))).Append("]");
                else text.Append("[未转换的消息内容：").Append(MaterialMd(type)).Append("]");
                text.Append("\n\n");
            }
            return text.ToString().Trim();
        }
    }

    private sealed class ChatArchiveImages
    {
        private readonly string folder, cwd; private readonly Action<string> warn;
        private readonly Dictionary<string, string> copied = new Dictionary<string, string>(StringComparer.Ordinal);
        public ChatArchiveImages(string destination, string directory, Action<string> warning) { folder = destination; cwd = directory; warn = warning; }
        public string Image(string source, string label, bool fromMarkdown = false)
        {
            try
            {
                if (String.IsNullOrWhiteSpace(source)) throw new InvalidDataException("消息未保留图片数据");
                byte[] data; string extension;
                Match inline = Regex.Match(source, @"\Adata:image/(png|jpeg|jpg|gif|webp|bmp);base64,([a-zA-Z0-9+/=\s]+)\z", RegexOptions.IgnoreCase);
                if (inline.Success)
                {
                    if (inline.Groups[2].Length > 28 * 1024 * 1024) throw new InvalidDataException("图片超过 20 MB");
                    extension = "." + inline.Groups[1].Value.ToLowerInvariant(); if (extension == ".jpeg") extension = ".jpg";
                    data = Convert.FromBase64String(inline.Groups[2].Value);
                }
                else if (source.StartsWith("iVBORw0KGgo", StringComparison.Ordinal) || source.StartsWith("/9j/", StringComparison.Ordinal) || source.StartsWith("UklGR", StringComparison.Ordinal) || source.StartsWith("R0lGOD", StringComparison.Ordinal))
                {
                    if (source.Length > 28 * 1024 * 1024) throw new InvalidDataException("图片超过 20 MB");
                    extension = source.StartsWith("/9j/", StringComparison.Ordinal) ? ".jpg" : source.StartsWith("UklGR", StringComparison.Ordinal) ? ".webp" : source.StartsWith("R0lGOD", StringComparison.Ordinal) ? ".gif" : ".png"; data = Convert.FromBase64String(source);
                }
                else
                {
                    Uri uri;
                    string file = source;
                    if (Uri.TryCreate(source, UriKind.Absolute, out uri))
                    {
                        if (!uri.IsFile) throw new InvalidDataException("网络图片不自动下载");
                        file = uri.LocalPath;
                    }
                    else file = Path.Combine(cwd, Uri.UnescapeDataString(source));
                    file = Path.GetFullPath(file); extension = Path.GetExtension(file).ToLowerInvariant();
                    if (fromMarkdown && !MaterialInside(file, cwd) && !MaterialInside(file, AttachmentDirectory)) throw new InvalidDataException("Markdown 图片不在论文或附件目录内");
                    if (!new[] { ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".avif", ".svg" }.Contains(extension)) throw new InvalidDataException("不是支持的本地图片格式");
                    MaterialNoLinks(file);
                    if (!File.Exists(file)) throw new FileNotFoundException("原图片已不存在");
                    if (new FileInfo(file).Length > 20 * 1024 * 1024) throw new InvalidDataException("图片超过 20 MB");
                    data = File.ReadAllBytes(file);
                    if (extension == ".svg") warn("对话图片包含 SVG，请核对其外部资源引用。");
                }
                if (data.Length > 20 * 1024 * 1024) throw new InvalidDataException("图片超过 20 MB");
                string hash; using (SHA256 sha = SHA256.Create()) hash = BitConverter.ToString(sha.ComputeHash(data)).Replace("-", "");
                string relative;
                if (!copied.TryGetValue(hash, out relative))
                {
                    relative = "图片/I" + (copied.Count + 1).ToString("D4") + extension;
                    string destination = Path.Combine(folder, relative.Replace('/', Path.DirectorySeparatorChar));
                    MaterialNoLinks(Path.GetDirectoryName(destination)); Directory.CreateDirectory(Path.GetDirectoryName(destination));
                    using (FileStream output = new FileStream(destination, FileMode.CreateNew, FileAccess.Write)) output.Write(data, 0, data.Length);
                    copied.Add(hash, relative);
                }
                return "![" + MaterialMd(label) + "](" + MaterialLink(relative) + ")";
            }
            catch (Exception ex) { warn("对话图片未复制：" + ex.Message); return "[图片未导出：" + MaterialMd(ex.Message) + "]"; }
        }
        public string Rewrite(string text)
        {
            // Leave code examples alone; rewrite image links only in ordinary Markdown prose.
            var output = new StringBuilder(); string fence = null;
            foreach (string line in (text ?? "").Replace("\r\n", "\n").Split('\n'))
            {
                Match marker = Regex.Match(line, @"^\s{0,3}(`{3,}|~{3,})");
                if (marker.Success) { if (fence == null) fence = marker.Groups[1].Value; else if (marker.Groups[1].Value[0] == fence[0] && marker.Groups[1].Length >= fence.Length) fence = null; output.Append(line).Append('\n'); continue; }
                output.Append(fence != null ? line : Regex.Replace(line, @"`+[^`]*`+|!\[([^\]\r\n]*)\]\((?:<([^>\r\n]+)>|([^\s)]+))(?:\s+""[^""\r\n]*"")?\)", delegate(Match match) {
                    if (match.Value[0] == '`') return match.Value;
                    return Image(match.Groups[2].Success ? match.Groups[2].Value : match.Groups[3].Value, match.Groups[1].Value, true);
                })).Append('\n');
            }
            return output.ToString().TrimEnd('\n');
        }
    }
}
