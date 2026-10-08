<script setup lang="ts">
/**
 * 后台登录页 —— 登录的是**你（管理员）**，不是客户。
 * 所以这里没有「注册」：客户在 Mimitale 客户端里自助注册，
 * 管理员账号是预置的（真实后端里由部署时的初始化脚本写入）。
 */
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Lock, User as UserIcon } from '@element-plus/icons-vue'
import { useAuthStore } from '@/stores/auth'
import { USE_MOCK } from '@/api/request'

const auth = useAuthStore()
const router = useRouter()

const username = ref('')
const password = ref('')

async function handleLogin(): Promise<void> {
  if (!username.value.trim()) {
    ElMessage.warning('请填写账号')
    return
  }
  if (!password.value) {
    ElMessage.warning('请填写密码')
    return
  }
  try {
    await auth.login(username.value.trim(), password.value)
    ElMessage.success('欢迎回来')
    router.push({ name: 'customers' })
  } catch {
    // 具体错误 request 层已经弹过了
  }
}
</script>

<template>
  <div class="login-page">
    <div class="card">
      <div class="brand">
        <div class="brand-mark">M</div>
        <div>
          <div class="brand-name">Mimitale</div>
          <div class="brand-sub">客户管理后台</div>
        </div>
      </div>

      <el-form label-position="top" @submit.prevent="handleLogin">
        <el-form-item label="管理员账号">
          <el-input
            v-model="username"
            size="large"
            placeholder="admin"
            :prefix-icon="UserIcon"
            @keyup.enter="handleLogin"
          />
        </el-form-item>

        <el-form-item label="密码">
          <el-input
            v-model="password"
            type="password"
            size="large"
            show-password
            placeholder="请输入密码"
            :prefix-icon="Lock"
            @keyup.enter="handleLogin"
          />
        </el-form-item>

        <el-button
          type="primary"
          size="large"
          class="submit"
          :loading="auth.loading"
          @click="handleLogin"
        >
          登录
        </el-button>
      </el-form>

      <p class="hint">
        <template v-if="USE_MOCK">
          当前是 <b>Mock 模式</b>，试玩账号 <b>admin</b> / 密码 <b>admin123</b>。
          <br />
          后台账号是预置的，这里没有注册入口 —— 客户才需要注册，而且是去
          Mimitale 客户端里注册。
        </template>
        <template v-else>
          管理员账号由部署时初始化写入，不提供自助注册。
        </template>
      </p>
    </div>
  </div>
</template>

<style scoped>
.login-page {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(160deg, #f4f5f7 0%, #eceef3 100%);
  padding: 24px;
}

.card {
  width: 100%;
  max-width: 400px;
  background: #fff;
  border: 1px solid var(--line);
  border-radius: 14px;
  padding: 30px;
}

.brand {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 24px;
}

.brand-mark {
  width: 42px;
  height: 42px;
  border-radius: 11px;
  background: #534ab7;
  color: #fff;
  font-size: 19px;
  font-weight: 500;
  display: flex;
  align-items: center;
  justify-content: center;
  flex: none;
}

.brand-name {
  font-size: 17px;
  font-weight: 500;
  line-height: 1.3;
}

.brand-sub {
  font-size: 12px;
  color: var(--text-sub);
  line-height: 1.3;
}

.submit {
  width: 100%;
  margin-top: 4px;
}

.hint {
  margin: 18px 0 0;
  font-size: 12px;
  line-height: 1.8;
  color: var(--text-sub);
}

.hint b {
  color: #854f0b;
  font-weight: 500;
}
</style>
