import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import './styles/global.css'

const app = createApp(App)
app.config.errorHandler = (error, _instance, info) => {
  console.error(`Vue render error (${info})`, error)
}
router.onError((error) => {
  console.error('Router navigation error', error)
})

app.use(createPinia()).use(router).mount('#app')
