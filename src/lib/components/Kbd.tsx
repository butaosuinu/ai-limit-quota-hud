type Props = {
  keys: readonly string[];
};

export function Kbd({ keys }: Props) {
  return (
    <span className="kbd-cluster">
      {keys.map((key, index) => (
        <kbd key={`${key}-${index.toString()}`} className="kbd">
          {key}
        </kbd>
      ))}
    </span>
  );
}
