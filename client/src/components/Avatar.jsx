export default function Avatar({ name, size = 38 }) {
  const initials = (name || '?')
    .split(' ')
    .map((p) => p[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();
  return (
    <div className="avatar" style={{ width: size, height: size, fontSize: size * 0.42 }}>
      {initials}
    </div>
  );
}
