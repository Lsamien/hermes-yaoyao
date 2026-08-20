/**
 * Yaoyao - dashboard plugin frontend.
 *
 * Plain IIFE, no build step. Uses window.__HERMES_PLUGIN_SDK__ for React +
 * shadcn-ui primitives + fetchJSON / authedFetch. Backend routes live under
 * /api/plugins/yaoyao/ (auto-mounted by the dashboard plugin loader).
 */
(function () {
  "use strict";

  const SDK = window.__HERMES_PLUGIN_SDK__;
  if (!SDK) return;
  const { React } = SDK;
  const h = React.createElement;
  const { useState, useEffect, useCallback, useRef, useMemo } = SDK.hooks;
  const {
    Card,
    CardContent,
    Badge,
    Button,
    Input,
    Label,
    Select,
    SelectOption,
  } = SDK.components;
  const { cn, timeAgo } = SDK.utils;
  const fetchJSON = SDK.fetchJSON;
  const authedFetch = SDK.authedFetch;

  const API = "/api/plugins/yaoyao";

  // ---------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------

  function inferKind(name, mimeType) {
    const ext = (name.split(".").pop() || "").toLowerCase();
    if ((mimeType || "").startsWith("image/") ||
        ["png","jpg","jpeg","gif","webp","bmp","svg","tiff","tif"].includes(ext))
      return "image";
    if ((mimeType || "").startsWith("video/") ||
        ["mp4","mov","avi","mkv","webm","m4v","wmv","flv"].includes(ext))
      return "video";
    if ((mimeType || "").startsWith("text/") ||
        ["txt","md","json","yaml","yml","csv","log","py","js","ts","html","xml","rst"].includes(ext))
      return "text";
    return "file";
  }

  function formatBytes(n) {
    if (!n || n <= 0) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    let i = 0, v = n;
    while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
    return v >= 100 ? v.toFixed(0) + " " + units[i]
         : v >= 10  ? v.toFixed(1) + " " + units[i]
                    : v.toFixed(2) + " " + units[i];
  }

  function senderLabel(s) {
    return s === "user" ? "用户" : s === "agent" ? "Agent" : s;
  }

  function kindIcon(kind) {
    switch (kind) {
      case "image": return "🖼";
      case "video": return "🎬";
      case "text": return "📄";
      default: return "📦";
    }
  }

  // ---------------------------------------------------------------------
  // Thumbnail image: fetch as blob via authedFetch (img tags can't set
  // Authorization headers), then create an object URL.
  // ---------------------------------------------------------------------

  function Thumbnail({ item, profile }) {
    const [url, setUrl] = useState(null);
    const [err, setErr] = useState(false);
    const kind = inferKind(item.name, item.mimeType);

    useEffect(() => {
      if (kind !== "image") return;
      let revoke = null;
      let cancelled = false;
      const dlUrl = `${API}/${item.id}/download` + (profile ? `?profile=${encodeURIComponent(profile)}` : "");
      authedFetch(dlUrl)
        .then((res) => res.blob())
        .then((blob) => {
          if (cancelled) return;
          const u = URL.createObjectURL(blob);
          revoke = u;
          setUrl(u);
        })
        .catch(() => { if (!cancelled) setErr(true); });
      return () => {
        cancelled = true;
        if (revoke) URL.revokeObjectURL(revoke);
      };
    }, [item.id, profile]);

    if (kind !== "image") {
      return h("div", {
        className: "yaoyao-thumb yaoyao-thumb-icon",
      }, kindIcon(kind));
    }
    if (err) return h("div", { className: "yaoyao-thumb yaoyao-thumb-icon" }, "🖼");
    if (!url) return h("div", { className: "yaoyao-thumb yaoyao-thumb-loading" }, "…");
    return h("img", {
      src: url,
      alt: item.name,
      className: "yaoyao-thumb yaoyao-thumb-img",
      loading: "lazy",
    });
  }

  // ---------------------------------------------------------------------
  // File card
  // ---------------------------------------------------------------------

  function FileCard({ item, onDownload, profile }) {
    const kind = inferKind(item.name, item.mimeType);
    return h(Card, { className: "yaoyao-card" },
      h(CardContent, { className: "yaoyao-card-content" },
        h("div", { className: "yaoyao-card-preview" },
          h(Thumbnail, { item: item, profile: profile })
        ),
        h("div", { className: "yaoyao-card-info" },
          h("div", { className: "yaoyao-card-name", title: item.name }, item.name),
          h("div", { className: "yaoyao-card-meta" },
            h(Badge, { variant: "secondary" }, senderLabel(item.origins && item.origins[0] ? item.origins[0].authorKind : "agent")),
            h("span", { className: "yaoyao-card-size" }, formatBytes(item.size)),
            item.messageTimestamp
              ? h("span", { className: "yaoyao-card-time" }, timeAgo(item.messageTimestamp * 1000))
              : null
          ),
          h("div", { className: "yaoyao-card-actions" },
            h(Button, {
              variant: "outline",
              size: "sm",
              onClick: () => onDownload(item),
            }, "下载")
          )
        )
      )
    );
  }

  // ---------------------------------------------------------------------
  // Main page
  // ---------------------------------------------------------------------

  function YaoyaoFilesPage() {
    const [items, setItems] = useState([]);
    const [loading, setLoading] = useState(true);
    const [loadingMore, setLoadingMore] = useState(false);
    const [error, setError] = useState(null);
    const [cursor, setCursor] = useState(null);
    const [hasMore, setHasMore] = useState(false);
    const [stats, setStats] = useState(null);
    const [profiles, setProfiles] = useState([]);
    // Initial profile from the URL (?profile=gril) so deep links / shared
    // links land on the right agent's library; fall back to "default".
    const [profile, setProfile] = useState(() => {
      try {
        const u = new URL(window.location.href);
        const p = u.searchParams.get("profile");
        return p || "default";
      } catch (e) {
        return "default";
      }
    });
    const [filter, setFilter] = useState({ sender: "", kind: "" });
    const [search, setSearch] = useState("");
    const [searchInput, setSearchInput] = useState("");
    const sentinelRef = useRef(null);

    // Keep the URL ?profile= in sync with the dropdown selection so the
    // address bar reflects what's shown (and is shareable / refreshable).
    useEffect(() => {
      try {
        const u = new URL(window.location.href);
        if (profile && profile !== "default") {
          u.searchParams.set("profile", profile);
        } else {
          u.searchParams.delete("profile");
        }
        window.history.replaceState(null, "", u.toString());
      } catch (e) { /* ignore */ }
    }, [profile]);

    // Also react to back/forward navigation so the dropdown follows the URL.
    useEffect(() => {
      const onPop = () => {
        try {
          const u = new URL(window.location.href);
          const p = u.searchParams.get("profile") || "default";
          setProfile(p);
        } catch (e) { /* ignore */ }
      };
      window.addEventListener("popstate", onPop);
      return () => window.removeEventListener("popstate", onPop);
    }, []);

    // Profiles dropdown: which agents have libraries. default always present.
    useEffect(() => {
      fetchJSON(`${API}/profiles`)
        .then((res) => {
          const list = (res.profiles || []);
          setProfiles(list);
          // If the current selection vanished (profile deleted), fall back.
          if (list.length && !list.some((p) => p.name === profile)) {
            setProfile("default");
          }
        })
        .catch(() => {});
    }, []); // eslint-disable-line

    // Fetch first page whenever filter / search / profile changes.
    const loadFirst = useCallback(async () => {
      setLoading(true);
      setError(null);
      try {
        const params = { limit: 50 };
        if (profile) params.profile = profile;
        if (filter.sender) params.sender = filter.sender;
        if (filter.kind) params.kind = filter.kind;
        if (search) params.search = search;
        const qs = new URLSearchParams(params).toString();
        const res = await fetchJSON(`${API}/files?${qs}`);
        setItems(res.items || []);
        setCursor(res.nextCursor || null);
        setHasMore(!!res.nextCursor);
      } catch (e) {
        setError(String(e.message || e));
      } finally {
        setLoading(false);
      }
    }, [filter, search, profile]);

    useEffect(() => { loadFirst(); }, [loadFirst]);

    // Stats (re-fetch when profile changes)
    useEffect(() => {
      const params = {};
      if (profile) params.profile = profile;
      const qs = new URLSearchParams(params).toString();
      fetchJSON(`${API}/stats?${qs}`).then(setStats).catch(() => {});
    }, [profile]);

    // Load more
    const loadMore = useCallback(async () => {
      if (!cursor || loadingMore) return;
      setLoadingMore(true);
      try {
        const params = { limit: 50, cursor };
        if (profile) params.profile = profile;
        if (filter.sender) params.sender = filter.sender;
        if (filter.kind) params.kind = filter.kind;
        if (search) params.search = search;
        const qs = new URLSearchParams(params).toString();
        const res = await fetchJSON(`${API}/files?${qs}`);
        setItems((prev) => [...prev, ...(res.items || [])]);
        setCursor(res.nextCursor || null);
        setHasMore(!!res.nextCursor);
      } catch (e) {
        setError(String(e.message || e));
      } finally {
        setLoadingMore(false);
      }
    }, [cursor, filter, search, profile, loadingMore]);

    // Infinite scroll via IntersectionObserver
    useEffect(() => {
      const el = sentinelRef.current;
      if (!el || !hasMore) return;
      const obs = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting) loadMore();
      }, { rootMargin: "200px" });
      obs.observe(el);
      return () => obs.disconnect();
    }, [hasMore, loadMore]);

    const onDownload = useCallback(async (item) => {
      try {
        const url = `${API}/${item.id}/download` + (profile ? `?profile=${encodeURIComponent(profile)}` : "");
        const res = await authedFetch(url);
        const blob = await res.blob();
        const urlObj = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = urlObj;
        a.download = item.name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(urlObj), 10000);
      } catch (e) {
        alert("下载失败: " + (e.message || e));
      }
    }, [profile]);

    const onSearchSubmit = useCallback((e) => {
      e.preventDefault();
      setSearch(searchInput.trim());
    }, [searchInput]);

    return h("div", { className: "yaoyao-page" },
      // Header + stats
      h("div", { className: "yaoyao-header" },
        h("h2", null, "夭夭文件库"),
        stats ? h("div", { className: "yaoyao-stats" },
          profile && profile !== "default"
            ? h(Badge, { variant: "secondary" }, `Agent: ${profile}`)
            : null,
          h(Badge, { variant: "secondary" }, `共 ${stats.totalAttachments} 个文件`),
          h(Badge, { variant: "secondary" }, `${formatBytes(stats.totalBytes)}`),
          stats.bySender && stats.bySender.agent
            ? h(Badge, { variant: "outline" }, `Agent ${stats.bySender.agent}`)
            : null,
          stats.bySender && stats.bySender.user
            ? h(Badge, { variant: "outline" }, `用户 ${stats.bySender.user}`)
            : null,
        ) : null
      ),

      // Filters
      h("div", { className: "yaoyao-filters" },
        h(Label, null, "Agent"),
        h(Select, {
          value: profile,
          onValueChange: setProfile,
          disabled: profiles.length === 0,
        },
          profiles.length === 0
            ? h(SelectOption, { value: "default" }, "默认")
            : profiles.map((p) =>
                h(SelectOption, { key: p.name, value: p.name }, p.label)
              )
        ),
        h(Label, null, "来源"),
        h(Select, {
          value: filter.sender,
          onValueChange: (value) => setFilter((f) => ({ ...f, sender: value })),
        },
          h(SelectOption, { value: "" }, "全部"),
          h(SelectOption, { value: "agent" }, "Agent"),
          h(SelectOption, { value: "user" }, "用户")
        ),
        h(Label, null, "类型"),
        h(Select, {
          value: filter.kind,
          onValueChange: (value) => setFilter((f) => ({ ...f, kind: value })),
        },
          h(SelectOption, { value: "" }, "全部"),
          h(SelectOption, { value: "image" }, "图片"),
          h(SelectOption, { value: "video" }, "视频"),
          h(SelectOption, { value: "text" }, "文本"),
          h(SelectOption, { value: "file" }, "文档")
        ),
        h("form", { onSubmit: onSearchSubmit, className: "yaoyao-search" },
          h(Input, {
            type: "text",
            placeholder: "搜索文件名…",
            value: searchInput,
            onChange: (e) => setSearchInput(e.target.value),
          }),
          h(Button, { type: "submit", size: "sm" }, "搜索")
        )
      ),

      // Error
      error ? h("div", { className: "yaoyao-error" }, "错误: " + error) : null,

      // Loading
      loading ? h("div", { className: "yaoyao-loading" }, "加载中…") :
      // Grid
      items.length === 0
        ? h("div", { className: "yaoyao-empty" }, "暂无文件")
        : h("div", { className: "yaoyao-grid" },
            items.map((item) =>
              h(FileCard, { key: item.id, item: item, onDownload: onDownload, profile: profile })
            )
          ),

      // Infinite scroll sentinel
      hasMore ? h("div", {
        ref: sentinelRef,
        className: "yaoyao-sentinel"
      }, loadingMore ? "加载更多…" : "") : null
    );
  }

  // ---------------------------------------------------------------------
  // Agent display-name settings page
  // ---------------------------------------------------------------------

  function AgentSettingsPage() {
    const [profiles, setProfiles] = useState([]);
    const [profile, setProfile] = useState("default");
    const [settings, setSettings] = useState(null);
    const [draftName, setDraftName] = useState("");
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState(null);
    const [savedMsg, setSavedMsg] = useState(null);

    useEffect(() => {
      fetchJSON(`${API}/profiles`)
        .then((response) => setProfiles(response.profiles || []))
        .catch((requestError) => setError(String(requestError.message || requestError)));
    }, []);

    useEffect(() => {
      let cancelled = false;
      setLoading(true);
      setError(null);
      fetchJSON(`${API}/agent/settings?profile=${encodeURIComponent(profile)}`)
        .then((response) => {
          if (cancelled) return;
          setSettings(response);
          setDraftName(response.agentName || "");
        })
        .catch((requestError) => {
          if (!cancelled) setError(String(requestError.message || requestError));
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
      return () => { cancelled = true; };
    }, [profile]);

    async function saveAgentName() {
      setSaving(true);
      setError(null);
      try {
        const response = await fetchJSON(
          `${API}/agent/settings?profile=${encodeURIComponent(profile)}`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ agentName: draftName.trim() }),
          },
        );
        setSettings(response);
        setDraftName(response.agentName || "");
        setProfiles((current) => current.map((item) =>
          item.name === profile
            ? {
                ...item,
                agentName: response.agentName,
                label: response.agentName || (profile === "default" ? "默认" : profile),
              }
            : item
        ));
        setSavedMsg("已保存");
        setTimeout(() => setSavedMsg(null), 2000);
      } catch (requestError) {
        setError(String(requestError.message || requestError));
      } finally {
        setSaving(false);
      }
    }

    const effectiveName = settings?.agentName || (profile === "default" ? "default" : profile);
    const readApi = `${API}/agent/settings?profile=${encodeURIComponent(profile)}`;

    return h("div", { className: "yaoyao-page" },
      h("div", { className: "yaoyao-header" },
        h("h2", null, "Agent 设置"),
        savedMsg ? h(Badge, { variant: "secondary" }, savedMsg) : null
      ),
      h(Card, null,
        h(CardContent, { className: "yaoyao-voice-card" },
          h("div", { className: "yaoyao-voice-row" },
            h(Label, { htmlFor: "agent-profile" }, "Hermes Profile"),
            h(Select, {
              id: "agent-profile",
              value: profile,
              onValueChange: setProfile,
              disabled: profiles.length === 0,
            },
              profiles.map((item) =>
                h(SelectOption, { key: item.name, value: item.name },
                  item.label === item.name ? item.name : `${item.label} (${item.name})`
                )
              )
            )
          ),
          loading
            ? h("div", { className: "yaoyao-loading" }, "加载中…")
            : h(React.Fragment, null,
                h("div", { className: "yaoyao-voice-row" },
                  h(Label, { htmlFor: "agent-name" }, "Agent 名称"),
                  h(Input, {
                    id: "agent-name",
                    type: "text",
                    maxLength: 100,
                    value: draftName,
                    placeholder: `留空时使用 ${profile}`,
                    onChange: (event) => setDraftName(event.target.value),
                  })
                ),
                h("div", { className: "yaoyao-duplex-meta" },
                  h("div", null,
                    h("span", { className: "yaoyao-meta-label" }, "当前显示名称"),
                    h("span", null, effectiveName)
                  ),
                  h("div", null,
                    h("span", { className: "yaoyao-meta-label" }, "读取 API"),
                    h("code", null, readApi)
                  )
                ),
                h("p", { className: "yaoyao-hint" },
                  "名称只用于展示，Profile ID 仍作为稳定的路由与数据隔离标识。留空保存可恢复默认名称。"
                ),
                h("div", { className: "yaoyao-voice-actions" },
                  h(Button, {
                    onClick: saveAgentName,
                    disabled: saving,
                  }, saving ? "保存中…" : "保存")
                )
              )
        )
      ),
      error ? h("div", { className: "yaoyao-error" }, error) : null
    );
  }

  // ---------------------------------------------------------------------
  // Voice settings page
  // ---------------------------------------------------------------------

  // ---------------------------------------------------------------------
  // Duplex voice settings page
  // Mirrors yaoyao-webui's IosDuplexVoiceSettings.vue contract:
  // {hasApiKey, voices:[{id,name}], currentVoiceId, updatedAt}
  // ---------------------------------------------------------------------

  function VoiceSettingsPage() {
    const [settings, setSettings] = useState(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [switching, setSwitching] = useState(false);
    const [error, setError] = useState(null);
    const [savedMsg, setSavedMsg] = useState(null);

    // Draft state for the editor
    const [draftApiKey, setDraftApiKey] = useState("");
    const [draftVoices, setDraftVoices] = useState([]);
    const [draftCurrent, setDraftCurrent] = useState("");
    const [editing, setEditing] = useState(false);

    useEffect(() => {
      load();
    }, []);

    async function load() {
      setLoading(true);
      try {
        const s = await fetchJSON(`${API}/voice/settings`);
        setSettings(s);
      } catch (e) {
        setError(String(e.message || e));
      } finally {
        setLoading(false);
      }
    }

    const voiceOptions = useMemo(() => {
      if (!settings) return [];
      return settings.voices
        .filter((v) => v.id.trim() && v.name.trim())
        .map((v) => ({ label: v.name, value: v.id }));
    }, [settings]);

    const isConfigured = settings
      && settings.hasApiKey
      && voiceOptions.length > 0
      && voiceOptions.some((o) => o.value === settings.currentVoiceId);

    function openEditor() {
      setDraftApiKey("");
      setDraftVoices((settings?.voices || []).map((v) => ({ ...v })));
      setDraftCurrent(settings?.currentVoiceId || "");
      setEditing(true);
    }

    function addVoice() {
      setDraftVoices((prev) => [...prev, { id: "", name: "" }]);
    }

    function removeVoice(idx) {
      setDraftVoices((prev) => {
        const next = [...prev];
        const removed = next[idx];
        next.splice(idx, 1);
        if (removed?.id === draftCurrent) {
          setDraftCurrent(next[0]?.id || "");
        }
        return next;
      });
    }

    function updateVoice(idx, field, value) {
      setDraftVoices((prev) => {
        const next = [...prev];
        next[idx] = { ...next[idx], [field]: value };
        return next;
      });
    }

    async function saveSettings() {
      setSaving(true);
      setError(null);
      try {
        const body = {
          voices: draftVoices.map((v) => ({ id: v.id.trim(), name: v.name.trim() })),
          currentVoiceId: draftCurrent,
        };
        if (draftApiKey.trim()) body.apiKey = draftApiKey.trim();
        const s = await fetchJSON(`${API}/voice/settings`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        setSettings(s);
        setEditing(false);
        setSavedMsg("已保存");
        setTimeout(() => setSavedMsg(null), 2000);
      } catch (e) {
        setError(String(e.message || e));
      } finally {
        setSaving(false);
      }
    }

    async function switchVoice(voiceId) {
      if (switching || voiceId === settings.currentVoiceId) return;
      setSwitching(true);
      try {
        const s = await fetchJSON(`${API}/voice/current-voice`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ currentVoiceId: voiceId }),
        });
        setSettings((prev) => ({ ...prev, ...s }));
      } catch (e) {
        setError(String(e.message || e));
      } finally {
        setSwitching(false);
      }
    }

    if (loading) return h("div", { className: "yaoyao-loading" }, "加载中…");
    if (!settings) return h("div", { className: "yaoyao-error" }, "加载失败: " + error);

    const currentVoiceName = voiceOptions.find((o) => o.value === settings.currentVoiceId)?.label
      || settings.currentVoiceId
      || "未选择";

    return h("div", { className: "yaoyao-page" },
      h("div", { className: "yaoyao-header" },
        h("h2", null, "App 双流直连配置"),
        savedMsg ? h(Badge, { variant: "secondary" }, savedMsg) : null
      ),

      // Status card
      h(Card, null,
        h(CardContent, { className: "yaoyao-voice-card" },
          h("div", { className: "yaoyao-duplex-status" },
            h("div", { className: "yaoyao-duplex-icon" }, "D"),
            h("div", { className: "yaoyao-duplex-info" },
              h("div", { className: "yaoyao-duplex-title-row" },
                h("h5", null, "火山引擎 / 豆包 TTS"),
                h(Badge, {
                  variant: isConfigured ? "default" : "secondary",
                }, isConfigured ? "已配置" : "未配置")
              ),
              h("p", { className: "yaoyao-hint" },
                "iOS App 直连 TTS 引擎进行双流语音对话。API Key 和声音列表在此配置后，App 从 /voice/runtime 拉取。")
            )
          ),
          h("div", { className: "yaoyao-duplex-meta" },
            h("div", null, h("span", { className: "yaoyao-meta-label" }, "当前声音"), h("span", null, currentVoiceName)),
            h("div", null, h("span", { className: "yaoyao-meta-label" }, "API Key"), h("span", null, settings.hasApiKey ? "已存储" : "未设置")),
            h("div", null, h("span", { className: "yaoyao-meta-label" }, "声音数量"), h("span", null, String(settings.voices.length))),
          )
        )
      ),

      // Current voice quick switch
      h(Card, null,
        h(CardContent, { className: "yaoyao-voice-card" },
          h("div", { className: "yaoyao-voice-row" },
            h(Label, { htmlFor: "duplex-current" }, "当前声音"),
            h("div", { className: "yaoyao-voice-switch" },
              h(Select, {
                id: "duplex-current",
                value: settings.currentVoiceId,
                onValueChange: switchVoice,
                disabled: switching || voiceOptions.length === 0,
              },
                voiceOptions.map((o) =>
                  h(SelectOption, { key: o.value, value: o.value }, o.label)
                )
              ),
              h(Button, {
                variant: "outline",
                size: "sm",
                onClick: openEditor,
              }, "编辑配置")
            )
          )
        )
      ),

      error ? h("div", { className: "yaoyao-error" }, error) : null,

      // Editor (inline form)
      editing ? h(Card, null,
        h(CardContent, { className: "yaoyao-voice-card" },
          h("h3", { className: "yaoyao-section-title" }, "编辑双流配置"),

          // API Key
          h("div", { className: "yaoyao-voice-row" },
            h(Label, { htmlFor: "duplex-key" }, "API Key"),
            h(Input, {
              id: "duplex-key",
              type: "password",
              value: draftApiKey,
              placeholder: settings.hasApiKey ? "已存储 (留空保持不变)" : "输入 API Key",
              onChange: (e) => setDraftApiKey(e.target.value),
            })
          ),

          // Current voice in draft
          h("div", { className: "yaoyao-voice-row" },
            h(Label, { htmlFor: "duplex-draft-current" }, "当前声音"),
            h(Select, {
              id: "duplex-draft-current",
              value: draftCurrent,
              onValueChange: setDraftCurrent,
            },
              draftVoices
                .filter((v) => v.id.trim())
                .map((v) =>
                  h(SelectOption, { key: v.id, value: v.id }, v.name || v.id)
                )
            )
          ),

          // Voice list editor
          h("div", { className: "yaoyao-voice-row" },
            h(Label, null, "声音列表"),
            h("div", { className: "yaoyao-voice-editor" },
              draftVoices.map((voice, idx) =>
                h("div", { key: idx, className: "yaoyao-voice-editor-row" },
                  h(Input, {
                    type: "text",
                    placeholder: "声音名称 (如 小何 2.0)",
                    value: voice.name,
                    onChange: (e) => updateVoice(idx, "name", e.target.value),
                  }),
                  h(Input, {
                    type: "text",
                    placeholder: "声音 ID (如 zh_female_xiaohe_uranus_bigtts)",
                    value: voice.id,
                    onChange: (e) => updateVoice(idx, "id", e.target.value),
                  }),
                  h(Button, {
                    variant: "ghost",
                    size: "sm",
                    disabled: draftVoices.length <= 1,
                    onClick: () => removeVoice(idx),
                  }, "×")
                )
              ),
              h(Button, { variant: "outline", size: "sm", onClick: addVoice }, "+ 添加声音")
            )
          ),

          h("div", { className: "yaoyao-voice-actions" },
            h(Button, { variant: "ghost", onClick: () => setEditing(false) }, "取消"),
            h(Button, { onClick: saveSettings, disabled: saving }, saving ? "保存中…" : "保存")
          )
        )
      ) : null
    );
  }

  // ---------------------------------------------------------------------
  // TTS / STT provider settings page
  // Mirrors yaoyao-webui's VoiceSettings.vue + VoiceApiConfigurator.vue.
  // ---------------------------------------------------------------------

  function VoiceProvidersPage() {
    const [ttsData, setTtsData] = useState(null);
    const [sttData, setSttData] = useState(null);
    const [providersInfo, setProvidersInfo] = useState(null);
    const [error, setError] = useState(null);
    const [saving, setSaving] = useState(false);
    const [savedMsg, setSavedMsg] = useState(null);

    useEffect(() => {
      Promise.all([
        fetchJSON(`${API}/tts/settings`),
        fetchJSON(`${API}/stt/settings`),
        fetchJSON(`${API}/voice/providers-info`),
      ]).then(([t, s, p]) => {
        setTtsData(t);
        setSttData(s);
        setProvidersInfo(p);
      }).catch((e) => setError(String(e.message || e)));
    }, []);

    async function setTtsActive(provider) {
      try {
        await fetchJSON(`${API}/tts/settings/active`, {
          method: "PUT", headers: {"Content-Type":"application/json"},
          body: JSON.stringify({provider}),
        });
        setTtsData((d) => ({...d, activeProvider: provider}));
      } catch (e) { setError(String(e.message || e)); }
    }

    async function setSttActive(provider) {
      try {
        await fetchJSON(`${API}/stt/settings/active`, {
          method: "PUT", headers: {"Content-Type":"application/json"},
          body: JSON.stringify({provider}),
        });
        setSttData((d) => ({...d, activeProvider: provider}));
      } catch (e) { setError(String(e.message || e)); }
    }

    async function saveProvider(kind, provider, settings, secrets) {
      setSaving(true);
      setError(null);
      try {
        const endpoint = kind === "tts" ? `${API}/tts/settings/${provider}` : `${API}/stt/settings/${provider}`;
        const res = await fetchJSON(endpoint, {
          method: "PUT", headers: {"Content-Type":"application/json"},
          body: JSON.stringify({settings, secrets}),
        });
        // Refresh
        if (kind === "tts") {
          const fresh = await fetchJSON(`${API}/tts/settings`);
          setTtsData(fresh);
        } else {
          const fresh = await fetchJSON(`${API}/stt/settings`);
          setSttData(fresh);
        }
        setSavedMsg(`${provider} 已保存`);
        setTimeout(() => setSavedMsg(null), 2000);
      } catch (e) {
        setError(String(e.message || e));
      } finally {
        setSaving(false);
      }
    }

    async function deleteProvider(kind, provider) {
      if (!confirm(`确定删除 ${provider} 配置?`)) return;
      try {
        const endpoint = kind === "tts" ? `${API}/tts/settings/${provider}` : `${API}/stt/settings/${provider}`;
        await fetchJSON(endpoint, {method: "DELETE"});
        if (kind === "tts") {
          const fresh = await fetchJSON(`${API}/tts/settings`);
          setTtsData(fresh);
        } else {
          const fresh = await fetchJSON(`${API}/stt/settings`);
          setSttData(fresh);
        }
      } catch (e) { setError(String(e.message || e)); }
    }

    if (!ttsData || !sttData || !providersInfo) {
      return h("div", {className: "yaoyao-loading"}, "加载中…");
    }

    const ttsProviders = providersInfo.tts.providers;
    const sttProviders = providersInfo.stt.providers;

    function renderProviderCard(kind, info, data) {
      const settings = (data.settings || []).find(s => s.provider === info.id);
      const isActive = data.activeProvider === info.id;
      const hasKey = settings && settings.secrets && settings.secrets.apiKey === "[stored]";
      const isConfigured = info.id === "edge" || info.id === "browser" || hasKey;

      return h(Card, {key: info.id, className: cn("yaoyao-provider-card", isActive && "yaoyao-provider-active")},
        h(CardContent, {className: "yaoyao-voice-card"},
          h("div", {className: "yaoyao-provider-header"},
            h("div", {className: "yaoyao-provider-title-row"},
              h("h5", null, info.label),
              h(Badge, {variant: isActive ? "default" : "secondary"},
                isActive ? "当前" : (isConfigured ? "已配置" : "未配置"))
            ),
            h("p", {className: "yaoyao-hint"},
              info.needsKey ? "需要 API Key" : "免费 / 内置")
          ),
          h(ProviderEditor, {
            kind, info, settings: settings || null, saving,
            onSave: (s, sec) => saveProvider(kind, info.id, s, sec),
            onDelete: info.id !== "edge" && info.id !== "browser"
              ? () => deleteProvider(kind, info.id) : null,
            onActivate: () => kind === "tts" ? setTtsActive(info.id) : setSttActive(info.id),
          })
        )
      );
    }

    return h("div", {className: "yaoyao-page"},
      h("div", {className: "yaoyao-header"},
        h("h2", null, "语音引擎配置"),
        savedMsg ? h(Badge, {variant: "secondary"}, savedMsg) : null
      ),
      error ? h("div", {className: "yaoyao-error"}, error) : null,

      h("h3", {className: "yaoyao-section-title"}, "TTS (文字转语音)"),
      h("div", {className: "yaoyao-provider-list"},
        ttsProviders.map(info => renderProviderCard("tts", info, ttsData))
      ),

      h("h3", {className: "yaoyao-section-title"}, "STT (语音转文字)"),
      h("div", {className: "yaoyao-provider-list"},
        sttProviders.map(info => renderProviderCard("stt", info, sttData))
      )
    );
  }

  // Inline provider editor (expandable)
  function ProviderEditor({kind, info, settings, saving, onSave, onDelete, onActivate}) {
    const [expanded, setExpanded] = useState(false);
    const [draft, setDraft] = useState({});

    useEffect(() => {
      if (settings) {
        setDraft({
          baseUrl: settings.settings?.baseUrl || info.defaults?.baseUrl || "",
          model: settings.settings?.model || info.defaults?.model || "",
          voice: settings.settings?.voice || info.defaults?.voice || "",
          language: settings.settings?.language || info.defaults?.language || "",
          rate: settings.settings?.rate || "",
          pitch: settings.settings?.pitch || "",
          stylePrompt: settings.settings?.stylePrompt || "",
          apiKey: "",
        });
      } else {
        setDraft({
          baseUrl: info.defaults?.baseUrl || "",
          model: info.defaults?.model || "",
          voice: info.defaults?.voice || "",
          language: info.defaults?.language || "",
          apiKey: "",
        });
      }
    }, [info.id, settings]);

    function update(field, value) {
      setDraft(d => ({...d, [field]: value}));
    }

    function handleSave() {
      const s = {};
      const sec = {};
      if (draft.baseUrl) s.baseUrl = draft.baseUrl;
      if (draft.model) s.model = draft.model;
      if (draft.voice) s.voice = draft.voice;
      if (draft.language) s.language = draft.language;
      if (draft.rate) s.rate = draft.rate;
      if (draft.pitch) s.pitch = draft.pitch;
      if (draft.stylePrompt) s.stylePrompt = draft.stylePrompt;
      if (draft.apiKey) sec.apiKey = draft.apiKey;
      onSave(s, sec);
    }

    const hasKey = settings && settings.secrets && settings.secrets.apiKey === "[stored]";
    const showFields = info.settingsKeys || [];

    return h("div", {className: "yaoyao-provider-editor"},
      h("div", {className: "yaoyao-provider-actions"},
        h(Button, {variant: "outline", size: "sm", onClick: () => setExpanded(e => !e)},
          expanded ? "收起" : "展开"),
        onActivate ? h(Button, {variant: "ghost", size: "sm", onClick: onActivate}, "设为当前") : null,
      ),
      expanded ? h("div", {className: "yaoyao-provider-fields"},
        showFields.includes("baseUrl") ? h("div", {className: "yaoyao-voice-row"},
          h(Label, null, "Base URL"),
          h(Input, {type: "text", value: draft.baseUrl, onChange: e => update("baseUrl", e.target.value),
            placeholder: "https://..."})
        ) : null,
        showFields.includes("model") ? h("div", {className: "yaoyao-voice-row"},
          h(Label, null, "模型"),
          h(Input, {type: "text", value: draft.model, onChange: e => update("model", e.target.value),
            placeholder: "model id"})
        ) : null,
        showFields.includes("voice") ? h("div", {className: "yaoyao-voice-row"},
          h(Label, null, "声音"),
          h(Input, {type: "text", value: draft.voice, onChange: e => update("voice", e.target.value),
            placeholder: "voice id"})
        ) : null,
        showFields.includes("language") ? h("div", {className: "yaoyao-voice-row"},
          h(Label, null, "语言"),
          h(Input, {type: "text", value: draft.language, onChange: e => update("language", e.target.value),
            placeholder: "zh / en / ..."})
        ) : null,
        showFields.includes("rate") ? h("div", {className: "yaoyao-voice-row"},
          h(Label, null, "语速"),
          h(Input, {type: "text", value: draft.rate, onChange: e => update("rate", e.target.value),
            placeholder: "+0%"})
        ) : null,
        showFields.includes("pitch") ? h("div", {className: "yaoyao-voice-row"},
          h(Label, null, "音调"),
          h(Input, {type: "text", value: draft.pitch, onChange: e => update("pitch", e.target.value),
            placeholder: "+0Hz"})
        ) : null,
        showFields.includes("stylePrompt") ? h("div", {className: "yaoyao-voice-row"},
          h(Label, null, "风格提示"),
          h(Input, {type: "text", value: draft.stylePrompt, onChange: e => update("stylePrompt", e.target.value),
            placeholder: "style prompt"})
        ) : null,
        info.needsKey ? h("div", {className: "yaoyao-voice-row"},
          h(Label, null, "API Key"),
          h(Input, {type: "password", value: draft.apiKey,
            onChange: e => update("apiKey", e.target.value),
            placeholder: hasKey ? "已存储 (留空保持不变)" : "输入 API Key"})
        ) : null,
        h("div", {className: "yaoyao-voice-actions"},
          h(Button, {size: "sm", onClick: handleSave, disabled: saving},
            saving ? "保存中…" : "保存"),
          onDelete ? h(Button, {variant: "ghost", size: "sm", onClick: onDelete}, "删除") : null,
        )
      ) : null
    );
  }

  // ---------------------------------------------------------------------
  // Top-level page with internal tab switcher
  // ---------------------------------------------------------------------

  function YaoyaoPage() {
    const [tab, setTab] = useState("files");
    return h("div", { className: "yaoyao-root" },
      h("div", { className: "yaoyao-tabs" },
        h("button", {
          className: cn("yaoyao-tab", tab === "files" && "yaoyao-tab-active"),
          onClick: () => setTab("files"),
        }, "文件库"),
        h("button", {
          className: cn("yaoyao-tab", tab === "agent" && "yaoyao-tab-active"),
          onClick: () => setTab("agent"),
        }, "Agent设置"),
        h("button", {
          className: cn("yaoyao-tab", tab === "duplex" && "yaoyao-tab-active"),
          onClick: () => setTab("duplex"),
        }, "App双流直连"),
        h("button", {
          className: cn("yaoyao-tab", tab === "engines" && "yaoyao-tab-active"),
          onClick: () => setTab("engines"),
        }, "语音引擎")
      ),
      tab === "files" ? h(YaoyaoFilesPage)
      : tab === "agent" ? h(AgentSettingsPage)
      : tab === "duplex" ? h(VoiceSettingsPage)
      : h(VoiceProvidersPage)
    );
  }

  // Register the plugin page. The name MUST match manifest.json "name".
  if (window.__HERMES_PLUGINS__ &&
      typeof window.__HERMES_PLUGINS__.register === "function") {
    window.__HERMES_PLUGINS__.register("yaoyao", YaoyaoPage);
  }
})();
