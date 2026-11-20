<template>
  <v-main>
    <div v-if="appStore.currentProject">
      <h3>
        Tasks
        <v-btn
          v-if="canAddTasks"
          size="small"
          color="surface-variant"
          variant="text"
          icon="mdi-plus"
          @click="newTask"
        />
      </h3>
      <v-list>
        <v-list-item
          v-for="task of appStore.currentProject.hasTask as LdSet<Task>"
          :key="task['@id']"
        >
          <v-card v-if="task.prefLabel">
            <v-card-title>{{ task.prefLabel }}</v-card-title>
            <v-card-actions>
              <v-btn
                v-if="taskPermissions[task['@id']!]?.update"
                size="small"
                color="surface-variant"
                variant="text"
                icon="mdi-square-edit-outline"
                @click="editTask(task)"
              />
              <v-btn
                v-if="taskPermissions[task['@id']!]?.delete"
                size="small"
                color="surface-variant"
                variant="text"
                icon="mdi-delete-outline"
                @click="deleteTask(task)"
              />
            </v-card-actions>
          </v-card>
        </v-list-item>
      </v-list>
      <h3>
        Files
        <v-btn
          v-if="canAddFiles"
          size="small"
          color="surface-variant"
          variant="text"
          icon="mdi-plus"
          @click="fileUpload?.click()"
        />
      </h3>
      <v-list>
        <v-list-item v-for="file of files" :key="file['@id']">
          {{ file.fileName }}
          <v-btn icon="mdi-download" variant="plain" @click="downloadFile(file)" />
        </v-list-item>
      </v-list>
      <h3>
        Images
        <v-btn
          v-if="canAddImages"
          size="small"
          color="surface-variant"
          variant="text"
          icon="mdi-plus"
          @click="imageUpload?.click()"
        />
      </h3>
      <v-list>
        <v-list-item v-for="(dataUrl, index) in imageUrls" :key="index">
          <img :src="dataUrl" style="width: 100%" />
        </v-list-item>
      </v-list>
      <input-dialog
        :text="selectedTask?.prefLabel"
        :dialog="dialog"
        @cancel="dialog = false"
        @save="updateTask"
      />
      <a ref="download" style="visibility: hidden" />
      <input
        ref="fileUpload"
        type="file"
        style="visibility: hidden"
        @change="appStore.uploadFile($event)"
      />
      <input
        ref="imageUpload"
        type="file"
        style="visibility: hidden"
        @change="appStore.uploadImage($event)"
      />
    </div>
  </v-main>
</template>

<script lang="ts" setup>
import { LdSet } from '@ldo/ldo'
import { computedAsync } from '@vueuse/core'
import { computed, reactive, ref, watch } from 'vue'
import { useRoute } from 'vue-router'

import InputDialog from '@/components/InputDialog.vue'
import { useAppStore } from '@/store/app'

import type { File as FileObject } from '../../ldo/File.typings'
import type { Task } from '../../ldo/Task.typings'

const download = ref<HTMLAnchorElement>()
const fileUpload = ref<HTMLInputElement>()
const imageUpload = ref<HTMLInputElement>()

const route = useRoute()
const dialog = ref(false)

const selectedTask = ref<Task | null>(null)

const appStore = useAppStore()

const projectId = computed(() => appStore.currentProject?.['@id'])
const canAddTasks = computedAsync(async () => {
  try {
    return projectId.value ? await appStore.canAddTasks(projectId.value) : false
  } catch {
    return false
  }
}, false)
const canAddFiles = computedAsync(async () => {
  try {
    return projectId.value ? await appStore.canAddFiles(projectId.value) : false
  } catch {
    return false
  }
}, false)
const canAddImages = computedAsync(async () => {
  try {
    return projectId.value ? await appStore.canAddImages(projectId.value) : false
  } catch {
    return false
  }
}, false)

const taskPermissions = reactive<Record<string, { update: boolean; delete: boolean }>>({})
const taskIds = computed(() =>
  Array.from(appStore.currentProject?.hasTask ?? []).map((task) => task['@id']!)
)
watch(
  taskIds,
  async (ids) => {
    await Promise.all(
      ids.map(async (id) => {
        try {
          const [update, remove] = await Promise.all([
            appStore.canUpdate(id),
            appStore.canDelete(id),
          ])
          taskPermissions[id] = { update, delete: remove }
        } catch {
          taskPermissions[id] = { update: false, delete: false }
        }
      })
    )
  },
  { immediate: true }
)

const imageUrls = computedAsync(async () =>
  Promise.all(appStore.currentProject?.hasImage?.map(({ '@id': id }) => appStore.dataUrl(id)) || [])
)

const files = computed(
  () => appStore.currentProject?.hasFile?.map(({ '@id': id }) => appStore.getFileObject(id)) || []
)

watch(
  () => route.query.project,
  async (project) => {
    if (project && route.query.resourceServer) {
      appStore.setCurrentProject(route.query.resourceServer as string, project as string)
      appStore.loadTasks(project as string)
      appStore.loadFiles(project as string)
      appStore.loadImages(project as string)
    }
  },
  { immediate: true }
)

async function downloadFile(file: FileObject) {
  if (download.value) {
    download.value.download = file.fileName ?? 'file'
    download.value.href = await appStore.dataUrl(file['@id']!)
    download.value.click()
  }
}

async function updateTask(label: string) {
  let cTask: Task
  if (selectedTask.value) {
    cTask = appStore.changeData(selectedTask.value)
  } else {
    const createdTask = await appStore.draftTask(appStore.currentProject!['@id']!)
    cTask = appStore.changeData(createdTask)
  }
  cTask.prefLabel = label
  appStore.updateTask(cTask)
  selectedTask.value = null
  dialog.value = false
}

function deleteTask(task: Task) {
  if (window.confirm('Are you sure to delete')) {
    appStore.deleteTask(task)
  }
}

function newTask() {
  dialog.value = true
}

function editTask(task: Task) {
  selectedTask.value = task
  dialog.value = true
}
</script>
