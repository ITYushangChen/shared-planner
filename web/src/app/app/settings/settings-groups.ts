/** 设置分组定义：供「我的页」总览 与 设置面板页 共用，避免两处重复维护 */

export type TabId =
  | "profile"
  | "appearance"
  | "notifications"
  | "data"
  | "security"
  | "about"
  | "admin-accounts"
  | "admin-errors"
  | "admin-audit"
  | "admin-reset"
  | "admin-ban"
  | "admin-signout"
  | "admin-delete"
  | "admin-recovery";

export type SettingsGroup = {
  title: string;
  items: Array<{ id: TabId; label: string; desc: string }>;
};

export const GROUPS: SettingsGroup[] = [
  {
    title: "账户",
    items: [
      { id: "profile", label: "个人资料", desc: "头像、昵称、时区和登录邮箱" },
      { id: "security", label: "安全与登录", desc: "修改密码、退出登录" },
    ],
  },
  {
    title: "应用",
    items: [
      { id: "appearance", label: "外观", desc: "背景、任务颜色与空间级覆盖" },
      {
        id: "notifications",
        label: "通知",
        desc: "按类型开关通知与右下角弹窗",
      },
    ],
  },
  {
    title: "其他",
    items: [
      { id: "data", label: "数据与集成", desc: "导出任务数据" },
      { id: "about", label: "关于", desc: "账户信息与快捷入口" },
    ],
  },
];

// 管理后台看板分组：账户管理 / 错误日志 / 操作记录（仅管理员可见）
export const ADMIN_DASHBOARD_GROUP: SettingsGroup = {
  title: "管理后台",
  items: [
    {
      id: "admin-accounts",
      label: "账户管理",
      desc: "启用/禁用、升级/降级、查看每个账号的空间个数",
    },
    {
      id: "admin-errors",
      label: "错误日志",
      desc: "报错信息、报错操作与时间",
    },
    {
      id: "admin-audit",
      label: "操作记录",
      desc: "管理员关键写操作的审计日志",
    },
  ],
};

// 管理员工具分组：仅管理员可见（不放进「我的页」总览，只留在面板左栏）
export const ADMIN_GROUP: SettingsGroup = {
  title: "管理员工具",
  items: [
    {
      id: "admin-reset",
      label: "协助重置密码",
      desc: "凭邮箱为用户重置密码并生成新恢复码",
    },
    {
      id: "admin-ban",
      label: "封禁 / 解封",
      desc: "封禁用户并强制其所有设备下线，或解除封禁",
    },
    {
      id: "admin-signout",
      label: "强制下线",
      desc: "吊销某用户所有设备的会话",
    },
    {
      id: "admin-delete",
      label: "删除账号",
      desc: "删除用户及其数据（含空间转让/清理）",
    },
    {
      id: "admin-recovery",
      label: "恢复码管理",
      desc: "重生成或吊销用户的一次性恢复码",
    },
  ],
};

export const ALL_TABS = [...GROUPS, ADMIN_DASHBOARD_GROUP, ADMIN_GROUP].flatMap(
  (g) => g.items,
);

export function isTabId(v: string | null): v is TabId {
  return v != null && ALL_TABS.some((t) => t.id === v);
}
