import * as Tabs from '@radix-ui/react-tabs';

interface TabItem {
  value: string;
  label: string;
}

interface TabsBarProps {
  items: TabItem[];
  value: string;
  onValueChange: (v: string) => void;
  className?: string;
}

export function TabsBar({ items, value, onValueChange, className = '' }: TabsBarProps) {
  return (
    <Tabs.Root value={value} onValueChange={onValueChange}>
      <Tabs.List className={`inline-flex gap-1 p-1 rounded-ctrl bg-raised ${className}`}>
        {items.map((item) => (
          <Tabs.Trigger
            key={item.value}
            value={item.value}
            className="tab px-3 py-1.5 text-xs font-medium rounded-ctrl data-[state=active]:tab-active"
          >
            {item.label}
          </Tabs.Trigger>
        ))}
      </Tabs.List>
    </Tabs.Root>
  );
}
