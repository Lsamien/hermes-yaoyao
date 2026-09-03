<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { apiRequest } from '@/api/client'
const nodes = ref<Array<{ id: string; name: string; url: string }>>([]),
  name = ref(''),
  url = ref(''),
  username = ref(''),
  password = ref(''),
  error = ref(''),
  busy = ref(false)
async function load() {
  try {
    nodes.value = (await apiRequest<{ nodes: typeof nodes.value }>('/api/app/nodes')).nodes
  } catch (e) {
    error.value = String(e)
  }
}
async function add() {
  busy.value = true
  error.value = ''
  try {
    await apiRequest('/api/app/nodes', {
      method: 'POST',
      body: {
        name: name.value,
        url: url.value,
        username: username.value,
        password: password.value,
      },
    })
    password.value = ''
    name.value = ''
    url.value = ''
    await load()
  } catch (e) {
    error.value = e instanceof Error ? e.message : '连接失败'
  } finally {
    busy.value = false
  }
}
async function revoke(id: string) {
  try {
    await apiRequest(`/api/app/nodes/${id}`, { method: 'DELETE' })
    await load()
  } catch (e) {
    error.value = String(e)
  }
}
onMounted(load)
</script>
<template>
  <section class="nodes-panel">
    <p>连接其他 Hermes 节点后，可用它的基础 Agent 创建角色。连接只属于当前登录用户。</p>
    <p v-if="error" role="alert">{{ error }}</p>
    <article v-for="node in nodes" :key="node.id">
      <div>
        <strong>{{ node.name }}</strong
        ><small>{{ node.url }}</small>
      </div>
      <button @click="revoke(node.id)">断开</button>
    </article>
    <form @submit.prevent="add">
      <label>节点名称<input v-model="name" required maxlength="100" /></label
      ><label
        >Hermes 地址<input
          v-model="url"
          type="url"
          required
          placeholder="http://服务器:9119" /></label
      ><label>用户名<input v-model="username" autocomplete="off" /></label
      ><label>密码<input v-model="password" type="password" autocomplete="new-password" /></label
      ><button :disabled="busy">{{ busy ? '正在连接…' : '添加节点' }}</button>
    </form>
  </section>
</template>
<style scoped>
.nodes-panel {
  padding: 18px;
  display: grid;
  gap: 18px;
  color: var(--text-primary);
}
p {
  font-size: 13px;
  line-height: 1.7;
  color: var(--text-muted);
}
article {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 12px;
  border: 1px solid var(--line);
  border-radius: 10px;
}
article div {
  display: grid;
  gap: 5px;
}
small {
  font-size: 11px;
  color: var(--text-muted);
}
form {
  display: grid;
  gap: 15px;
}
label {
  display: grid;
  gap: 7px;
  font-size: 13px;
}
input,
button {
  border: 1px solid var(--line);
  border-radius: 9px;
  background: var(--surface-soft);
  color: inherit;
  padding: 10px;
}
button {
  cursor: pointer;
}
p[role='alert'] {
  color: var(--danger, #b44);
}
</style>
