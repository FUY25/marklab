interface BrandLockupProps {
  title: string;
  subtitle?: string | undefined;
}

export function BrandLockup({ title, subtitle }: BrandLockupProps) {
  return (
    <div className="brand-lockup">
      <img
        className="brand-logo"
        src={`${import.meta.env.BASE_URL}marklab-logo.svg`}
        alt=""
        aria-hidden="true"
      />
      <div>
        <h1>{title}</h1>
        {subtitle ? <p>{subtitle}</p> : null}
      </div>
    </div>
  );
}
