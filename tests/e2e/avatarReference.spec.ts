import {expect,test} from '@playwright/test'
// Standalone reference comparison; the regular app suite uses its own fixture.
test('matches all OpenMausBot canonical resting frames',async({page,context},testInfo)=>{
  const reference=await context.newPage()
  await reference.goto('http://127.0.0.1:18806')
  await page.goto('http://127.0.0.1:18807')
  await expect(reference.locator('[data-testid="shape-circle"] svg path[fill="#ffffff"]').first()).toHaveAttribute('d',/.+/)
  await expect(page.locator('[data-part=eye0]').first()).toHaveAttribute('d',/.+/)
  const ids=await page.locator('[data-testid]').evaluateAll(nodes=>nodes.map(n=>n.getAttribute('data-testid')!))
  expect(ids).toHaveLength(28)
  for(const id of ids){
    const expected=await reference.getByTestId(id).locator('svg').evaluate(svg=>{
      const eyes=[...svg.querySelectorAll('path[fill="#ffffff"]')].slice(0,2)
      const mouth=svg.querySelector('path[stroke="#ffffff"]')!
      const body=svg.querySelector('[fill^="url("]')!
      const attrs=(el:Element)=>Object.fromEntries([...el.attributes].filter(a=>!['fill','data-part'].includes(a.name)).map(a=>[a.name,a.value]))
      return {viewBox:svg.getAttribute('viewBox'),eyes:eyes.map(e=>({d:e.getAttribute('d'),transform:e.getAttribute('transform')})),mouth:{d:mouth.getAttribute('d'),transform:mouth.getAttribute('transform')},anchor:eyes[0]!.parentElement!.getAttribute('transform'),body:{tag:body.tagName,attrs:attrs(body)},color:svg.querySelector('stop')!.getAttribute('stop-color')!.toLowerCase()}
    })
    const actual=await page.getByTestId(id).locator('svg').evaluate(svg=>{
      const eyes=[svg.querySelector('[data-part=eye0]')!,svg.querySelector('[data-part=eye1]')!],mouth=svg.querySelector('[data-part=mouth]')!,body=svg.querySelector('[data-part=outline]')!.firstElementChild!
      const attrs=(el:Element)=>Object.fromEntries([...el.attributes].filter(a=>!['fill','data-part'].includes(a.name)).map(a=>[a.name,a.value]))
      return {viewBox:svg.getAttribute('viewBox'),eyes:eyes.map(e=>({d:e.getAttribute('d'),transform:e.getAttribute('transform')})),mouth:{d:mouth.getAttribute('d'),transform:mouth.getAttribute('transform')},anchor:eyes[0]!.parentElement!.getAttribute('transform'),body:{tag:body.tagName,attrs:attrs(body)},color:body.getAttribute('fill')!.toLowerCase()}
    })
    expect(actual,id).toEqual(expected)
  }
  await reference.screenshot({path:testInfo.outputPath('openmaus-reference.png'),fullPage:true})
  await page.screenshot({path:testInfo.outputPath('yaoyao-v2.png'),fullPage:true})
  await reference.close()
})
