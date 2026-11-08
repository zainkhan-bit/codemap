export class Base {
  save() {
    this.validate();
    return this;
  }
  validate() {}
}
