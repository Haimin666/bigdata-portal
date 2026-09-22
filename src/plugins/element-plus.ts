import type { App, Component } from 'vue'
import { ElAlert } from 'element-plus/es/components/alert/index.mjs'
import { ElBreadcrumb, ElBreadcrumbItem } from 'element-plus/es/components/breadcrumb/index.mjs'
import { ElButton, ElButtonGroup } from 'element-plus/es/components/button/index.mjs'
import { ElCard } from 'element-plus/es/components/card/index.mjs'
import { ElCheckbox, ElCheckboxButton, ElCheckboxGroup } from 'element-plus/es/components/checkbox/index.mjs'
import { ElCol } from 'element-plus/es/components/col/index.mjs'
import { ElCollapse, ElCollapseItem } from 'element-plus/es/components/collapse/index.mjs'
import { ElAside, ElContainer, ElMain } from 'element-plus/es/components/container/index.mjs'
import { ElDialog } from 'element-plus/es/components/dialog/index.mjs'
import { ElDivider } from 'element-plus/es/components/divider/index.mjs'
import { ElDrawer } from 'element-plus/es/components/drawer/index.mjs'
import { ElDropdown, ElDropdownItem, ElDropdownMenu } from 'element-plus/es/components/dropdown/index.mjs'
import { ElEmpty } from 'element-plus/es/components/empty/index.mjs'
import { ElForm, ElFormItem } from 'element-plus/es/components/form/index.mjs'
import { ElIcon } from 'element-plus/es/components/icon/index.mjs'
import { ElInput } from 'element-plus/es/components/input/index.mjs'
import { ElInputNumber } from 'element-plus/es/components/input-number/index.mjs'
import { ElLink } from 'element-plus/es/components/link/index.mjs'
import { ElMenu, ElMenuItem } from 'element-plus/es/components/menu/index.mjs'
import { ElOption, ElSelect } from 'element-plus/es/components/select/index.mjs'
import { ElPagination } from 'element-plus/es/components/pagination/index.mjs'
import { ElPopover } from 'element-plus/es/components/popover/index.mjs'
import { ElProgress } from 'element-plus/es/components/progress/index.mjs'
import { ElRadio, ElRadioButton, ElRadioGroup } from 'element-plus/es/components/radio/index.mjs'
import { ElResult } from 'element-plus/es/components/result/index.mjs'
import { ElRow } from 'element-plus/es/components/row/index.mjs'
import { ElSwitch } from 'element-plus/es/components/switch/index.mjs'
import { ElTabPane, ElTabs } from 'element-plus/es/components/tabs/index.mjs'
import { ElTable, ElTableColumn } from 'element-plus/es/components/table/index.mjs'
import { ElTag } from 'element-plus/es/components/tag/index.mjs'
import { ElTimeSelect } from 'element-plus/es/components/time-select/index.mjs'
import { ElTooltip } from 'element-plus/es/components/tooltip/index.mjs'
import { ElTree } from 'element-plus/es/components/tree/index.mjs'
import { ElLoading } from 'element-plus/es/components/loading/index.mjs'

import 'element-plus/theme-chalk/base.css'
import 'element-plus/theme-chalk/el-alert.css'
import 'element-plus/theme-chalk/el-breadcrumb.css'
import 'element-plus/theme-chalk/el-breadcrumb-item.css'
import 'element-plus/theme-chalk/el-button.css'
import 'element-plus/theme-chalk/el-button-group.css'
import 'element-plus/theme-chalk/el-card.css'
import 'element-plus/theme-chalk/el-checkbox.css'
import 'element-plus/theme-chalk/el-checkbox-button.css'
import 'element-plus/theme-chalk/el-checkbox-group.css'
import 'element-plus/theme-chalk/el-col.css'
import 'element-plus/theme-chalk/el-collapse.css'
import 'element-plus/theme-chalk/el-collapse-item.css'
import 'element-plus/theme-chalk/el-container.css'
import 'element-plus/theme-chalk/el-aside.css'
import 'element-plus/theme-chalk/el-header.css'
import 'element-plus/theme-chalk/el-main.css'
import 'element-plus/theme-chalk/el-footer.css'
import 'element-plus/theme-chalk/el-dialog.css'
import 'element-plus/theme-chalk/el-divider.css'
import 'element-plus/theme-chalk/el-drawer.css'
import 'element-plus/theme-chalk/el-dropdown.css'
import 'element-plus/theme-chalk/el-dropdown-item.css'
import 'element-plus/theme-chalk/el-dropdown-menu.css'
import 'element-plus/theme-chalk/el-empty.css'
import 'element-plus/theme-chalk/el-form.css'
import 'element-plus/theme-chalk/el-form-item.css'
import 'element-plus/theme-chalk/el-icon.css'
import 'element-plus/theme-chalk/el-input.css'
import 'element-plus/theme-chalk/el-input-number.css'
import 'element-plus/theme-chalk/el-loading.css'
import 'element-plus/theme-chalk/el-link.css'
import 'element-plus/theme-chalk/el-menu.css'
import 'element-plus/theme-chalk/el-menu-item.css'
import 'element-plus/theme-chalk/el-message.css'
import 'element-plus/theme-chalk/el-message-box.css'
import 'element-plus/theme-chalk/el-notification.css'
import 'element-plus/theme-chalk/el-option.css'
import 'element-plus/theme-chalk/el-pagination.css'
import 'element-plus/theme-chalk/el-popover.css'
import 'element-plus/theme-chalk/el-progress.css'
import 'element-plus/theme-chalk/el-radio.css'
import 'element-plus/theme-chalk/el-radio-button.css'
import 'element-plus/theme-chalk/el-radio-group.css'
import 'element-plus/theme-chalk/el-result.css'
import 'element-plus/theme-chalk/el-row.css'
import 'element-plus/theme-chalk/el-select.css'
import 'element-plus/theme-chalk/el-switch.css'
import 'element-plus/theme-chalk/el-tabs.css'
import 'element-plus/theme-chalk/el-tab-pane.css'
import 'element-plus/theme-chalk/el-table.css'
import 'element-plus/theme-chalk/el-table-column.css'
import 'element-plus/theme-chalk/el-tag.css'
import 'element-plus/theme-chalk/el-time-select.css'
import 'element-plus/theme-chalk/el-tooltip.css'
import 'element-plus/theme-chalk/el-tree.css'
import 'element-plus/theme-chalk/dark/css-vars.css'

const components: Component[] = [
  ElAlert,
  ElAside,
  ElBreadcrumb,
  ElBreadcrumbItem,
  ElButton,
  ElButtonGroup,
  ElCard,
  ElCheckbox,
  ElCheckboxButton,
  ElCheckboxGroup,
  ElCol,
  ElCollapse,
  ElCollapseItem,
  ElContainer,
  ElDialog,
  ElDivider,
  ElDrawer,
  ElDropdown,
  ElDropdownItem,
  ElDropdownMenu,
  ElEmpty,
  ElForm,
  ElFormItem,
  ElIcon,
  ElInput,
  ElInputNumber,
  ElLink,
  ElMain,
  ElMenu,
  ElMenuItem,
  ElOption,
  ElPagination,
  ElPopover,
  ElProgress,
  ElRadio,
  ElRadioButton,
  ElRadioGroup,
  ElResult,
  ElRow,
  ElSelect,
  ElSwitch,
  ElTabPane,
  ElTable,
  ElTableColumn,
  ElTabs,
  ElTag,
  ElTimeSelect,
  ElTooltip,
  ElTree
]

export default {
  install(app: App) {
    for (const component of components) {
      if (component.name) app.component(component.name, component)
    }
    app.use(ElLoading)
  }
}
